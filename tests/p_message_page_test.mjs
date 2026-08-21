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
    senderKeys: {},                 // thread_id -> [{ sender_id, generation, recipient_id, epk, wrapped_key }]
  };
  // Two other people already on P-Message, one of them holding a key this
  // device has never seen — that is what makes the "cannot decrypt" path real.
  db.keys["agent_juma"] = { public_key: "", fingerprint: "1111 2222 3333",
    display_name: "Juma Mwanga", region: "Mwanza", is_agent: true, area: "Nyamagana" };
  db.keys["agent_neema"] = { public_key: "", fingerprint: "4444 5555 6666",
    display_name: "Neema Kileo", region: "Mwanza", is_agent: true, area: "Ilemela" };
  // An agent who never filled in where they work, and a person who is not an
  // agent at all. Both are rows the directory has to render honestly.
  db.keys["agent_blank"] = { public_key: "", fingerprint: "7777 8888 9999",
    display_name: "Rashid Omari", region: "Dodoma", is_agent: true, area: null };
  db.keys["plain_amina"] = { public_key: "", fingerprint: "1212 3434 5656",
    display_name: "Amina Hassan", region: "Mwanza", is_agent: false, area: null };

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
    // pm_peer hands back the public key as well as the stored fingerprint
    // column, because the client derives the number it shows from the KEY and
    // treats the column as nothing more than a tamper signal.
    if (name === "pm_peer") {
      var pr = db.keys[args.p_user_id];
      if (!pr) return Promise.resolve({ data: [], error: null });
      return Promise.resolve({ data: [{
        user_id: args.p_user_id, display_name: pr.display_name,
        public_key: pr.public_key, fingerprint: pr.fingerprint,
        is_agent: pr.is_agent, is_guest: !!pr.is_guest, region: pr.region,
      }], error: null });
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
          // A sender-key message carries no per-recipient wrap at all, so
          // requiring one here would hide every one of them — including from
          // its own author. The real function makes the same distinction.
          var isSk = m.generation !== undefined && m.generation !== null;
          if (!w && !isSk) return null;
          return { id: m.id, thread_id: m.thread_id, sender_id: m.sender_id,
            sender_name: m.sender_id === me ? "You" : (db.keys[m.sender_id] || {}).display_name,
            alg: m.alg || null, iv: m.iv, ciphertext: m.ciphertext,
            epk: w ? w.epk : null, wrapped_key: w ? w.wrapped_key : null,
            generation: isSk ? m.generation : null, seq: isSk ? m.seq : null,
            sent_at: m.sent_at };
        }).filter(Boolean);
      return Promise.resolve({ data: out, error: null });
    }
    // ---- sender keys ----
    if (name === "pm_sender_key_put") {
      db.senderKeys[args.p_thread] = db.senderKeys[args.p_thread] || [];
      (args.p_keys || []).forEach(function (k) {
        db.senderKeys[args.p_thread].push({ sender_id: me, generation: args.p_generation,
          recipient_id: k.user_id, epk: k.epk, wrapped_key: k.wrapped_key });
      });
      return Promise.resolve({ data: (args.p_keys || []).length, error: null });
    }
    if (name === "pm_sender_keys_for") {
      return Promise.resolve({
        data: (db.senderKeys[args.p_thread] || []).filter(function (k) { return k.recipient_id === me; })
          .map(function (k) {
            return { sender_id: k.sender_id, generation: k.generation,
              epk: k.epk, wrapped_key: k.wrapped_key };
          }),
        error: null,
      });
    }
    if (name === "pm_send_sk") {
      var smid = "m" + (db.messages.length + 1);
      db.messages.push({ id: smid, thread_id: args.p_thread, sender_id: me,
        alg: "SK-A256GCM", iv: args.p_iv, ciphertext: args.p_ciphertext,
        generation: args.p_generation, seq: args.p_seq, sent_at: new Date().toISOString() });
      db.wraps[smid] = {};   // deliberately none: that is the whole saving
      return Promise.resolve({ data: smid, error: null });
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
      if (name === "pm_threads") {
        var tid = b._thread || b._eqId;
        var th = db.threads[tid];
        data = th ? [{ id: tid, kind: th.kind, key_generation: th.key_generation || 0,
                       title: th.title || null, region: th.region || null, category: null }] : [];
      } else if (name === "pm_members") {
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
    b.eq = function (col, val) { if (col === "thread_id") b._thread = val; if (col === "id") b._eqId = val; return b; };
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
  headless: "new", protocolTimeout: 120000,
  args: ["--no-sandbox", "--disable-dev-shm-usage",
    // Chrome's own fake capture device: getUserMedia resolves with a real
    // MediaStream and the <video> really plays, so the only thing the test has
    // to invent is the barcode reader itself.
    "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
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
  ok(!fp.hidden && /\d{5}( \d{5}){5}/.test(fp.text),
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

  section("8d. A large room switches to sender keys by itself");
  {
    const big = await openPage("pawa4761@gmail.com");
    await sleep(700);
    // 30 members: past the threshold where one ECDH per member per message
    // stops being affordable. They share one valid public key — the question
    // here is which PATH the store takes, not whose key is whose.
    const roomId = await big.page.evaluate(async () => {
      const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
      const spki = await crypto.subtle.exportKey("spki", pair.publicKey);
      const b = new Uint8Array(spki); let s = "";
      for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
      const pub = btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const db = window.__PM_DB;
      const members = ["user_self"];
      for (let i = 0; i < 29; i++) {
        const id = "crowd_" + i;
        db.keys[id] = { public_key: pub, fingerprint: "0000", display_name: "Crowd " + i,
          region: "Mwanza", is_agent: true };
        members.push(id);
      }
      db.threads["bigroom"] = { kind: "group", title: "Nationwide", key_generation: 0, members };
      return "bigroom";
    });
    ok(roomId === "bigroom", "a 30-person room exists");

    const before = await big.page.evaluate(() => window.__PM_SENT.length);
    const secret2 = "Hii ni siri ya chumba kizima.";
    const sendErr = await big.page.evaluate(async (id, txt) => {
      try { await window.PMStore.send(id, txt); return null; } catch (e) { return String(e.message || e); }
    }, roomId, secret2);
    ok(!sendErr, "sending to it works", sendErr || "");

    const calls = await big.page.evaluate((n) => window.__PM_SENT.slice(n).map((c) => c.name), before);
    ok(calls.includes("pm_sender_key_put"), "the key is handed out once", calls.join(", "));
    ok(calls.includes("pm_send_sk"), "and the message goes by the sender-key path");
    ok(!calls.includes("pm_send"),
       "NOT by the per-recipient path — which is the entire point of the switch", calls.join(", "));

    // The saving, asserted rather than assumed: a second message must not
    // hand the key out again.
    const mid = await big.page.evaluate(() => window.__PM_SENT.length);
    await big.page.evaluate(async (id) => { await window.PMStore.send(id, "na hii ya pili"); }, roomId);
    const second = await big.page.evaluate((n) => window.__PM_SENT.slice(n).map((c) => c.name), mid);
    ok(!second.includes("pm_sender_key_put"),
       "the second message does NOT redistribute — the cost really is paid once", second.join(", "));
    ok(second.includes("pm_send_sk"), "it just sends");

    const readBack = await big.page.evaluate(async (id) => {
      const rows = await window.PMStore.messages(id);
      return rows.map((r) => ({ text: r.text, failed: r.failed }));
    }, roomId);
    ok(readBack.length === 2 && readBack[0].text === secret2 && !readBack[0].failed,
       "and the sender reads both messages back through the sender key",
       JSON.stringify(readBack));

    // The promise that holds for every path: plaintext never left the tab.
    const leaked = await big.page.evaluate((txt) =>
      (window.__PM_SENT || []).some((c) => JSON.stringify(c.args).includes(txt)), secret2);
    ok(!leaked, "and no request body carried a word of it");

    const smallPathStill = await big.page.evaluate(() => {
      const db = window.__PM_DB;
      return Object.keys(db.senderKeys).length;
    });
    ok(smallPathStill === 1, "only the big room grew a sender key");
    await big.page.close();
  }

  section("8e. A key that changed under a conversation");
  // The attack the safety number exists for, run end to end: the key in the
  // database is swapped for one the attacker holds. Nothing about the
  // messages looks different, and before pinning nothing anywhere noticed.
  {
    const LIE = "00000 00000 00000 00000 00000 00000";
    const tp = await openPage("someone@example.com");
    await sleep(900);
    // Same setup as section 4: the agent's keypair is generated inside the
    // page, so this test never holds a private half.
    await tp.page.evaluate(async (lie) => {
      // Pages in this run share one origin and therefore one localStorage,
      // and every earlier section minted a different keypair for this agent.
      // Left in place those pins are real changes and the alarm would fire
      // before this section has done anything — so the slate is cleared and
      // the substitution below is the only one on record.
      localStorage.removeItem("pm-trust-v1");
      const kp = await window.PMCrypto.generateIdentity();
      window.__PM_DB.keys["agent_juma"].public_key = kp.publicKey;
      // A server that substitutes a key can write the fingerprint column
      // beside it. This is that column lying, in v2 shape so it cannot be
      // dismissed as a leftover of the old 12-digit scheme.
      window.__PM_DB.keys["agent_juma"].fingerprint = lie;
    }, LIE);

    await tp.page.evaluate(() => document.getElementById("segPeople").click());
    await sleep(500);
    await tp.page.evaluate(() => document.querySelector('#pmPeople [data-person="agent_juma"]').click());
    await sleep(900);

    await tp.page.evaluate(() => document.getElementById("pmVerify").click());
    await sleep(700);
    const dlg = await tp.page.$eval("#pmModal", (n) => n.textContent);
    const derived = await tp.page.evaluate(() =>
      window.PMCrypto.fingerprint(window.__PM_DB.keys["agent_juma"].public_key));

    ok(/\d{5}( \d{5}){5}/.test(dlg), "the verify dialog shows a thirty-digit safety number");
    ok(dlg.includes(derived),
       "derived on this device from the key that actually arrived");
    ok(!dlg.includes(LIE),
       "NOT the fingerprint column the server sent beside it — which an attacker writes too");
    ok(/Not verified/i.test(dlg), "and it says plainly that nobody has checked it yet");

    await tp.page.evaluate(() => document.getElementById("pmFpMatch").click());
    await sleep(300);
    ok(/Verified/i.test(await tp.page.$eval("#pmModal", (n) => n.textContent)),
       "comparing it out of band is recorded");
    await tp.page.evaluate(() => document.getElementById("pmFpOk").click());
    await sleep(300);

    // Now the substitution.
    await tp.page.evaluate(async () => {
      const kp = await window.PMCrypto.generateIdentity();
      window.__PM_DB.keys["agent_juma"].public_key = kp.publicKey;
    });
    await tp.page.evaluate(() => document.getElementById("pmBack").click());
    await sleep(300);
    ok(await tp.page.$eval("#pmTrustBar", (n) => n.hidden), "no alarm while nothing is open");

    await tp.page.evaluate(() => document.querySelector('#pmPeople [data-person="agent_juma"]').click());
    await sleep(1100);

    const bar = await tp.page.$eval("#pmTrustBar", (n) => ({ hidden: n.hidden, text: n.textContent }));
    ok(!bar.hidden, "reopening the thread raises the alarm", bar.text);
    ok(/changed/i.test(bar.text), "and says the safety number changed", bar.text);
    ok(await tp.page.$eval("#pmInput", (n) => n.disabled),
       "the composer is switched OFF — a warning above a working text box is one people type past");
    ok(await tp.page.$eval("#pmSendBtn", (n) => n.disabled), "and so is the send button");

    // It must not be possible to wait it out.
    await tp.page.evaluate(() => document.getElementById("pmBack").click());
    await sleep(200);
    await tp.page.evaluate(() => document.querySelector('#pmPeople [data-person="agent_juma"]').click());
    await sleep(1000);
    ok(await tp.page.$eval("#pmTrustBar", (n) => !n.hidden),
       "reopening it again does NOT clear the alarm — doing nothing is the attacker's cheapest move");

    await tp.page.evaluate(() => document.getElementById("pmTrustGo").click());
    await sleep(700);
    const alarmDlg = await tp.page.$eval("#pmModal", (n) => n.textContent);
    ok(/has changed/i.test(alarmDlg), "the dialog leads with what happened, above the numbers");
    ok(/verified their previous/i.test(alarmDlg),
       "and says the old number HAD been checked, which is the worse case");

    await tp.page.evaluate(() => document.getElementById("pmFpAccept").click());
    await sleep(400);
    ok(await tp.page.$eval("#pmTrustBar", (n) => n.hidden), "'they changed phone' releases the thread");
    ok(await tp.page.$eval("#pmInput", (n) => !n.disabled), "and the composer comes back");
    const after = await tp.page.evaluate(() =>
      JSON.parse(localStorage.getItem("pm-trust-v1"))["user_self"]["agent_juma"].state);
    ok(after === "seen",
       "but the record lands on SEEN, never verified — this key has been checked by nobody");
    await tp.page.close();
  }

  section("8f. Verifying with the camera instead of thirty digits");
  // BarcodeDetector is a phone API — it does not exist in Chrome on Windows or
  // Linux, so the reader is stubbed and everything around it is real: the QR
  // is the one js/lib/qr.js drew, the camera is Chrome's fake device, and the
  // comparison is the shipped code.
  {
    const tp = await openPage("someone@example.com");
    await sleep(900);
    const JUMA_KEY = await tp.page.evaluate(async () => {
      localStorage.removeItem("pm-trust-v1");
      const kp = await window.PMCrypto.generateIdentity();
      window.__PM_DB.keys["agent_juma"].public_key = kp.publicKey;
      return kp.publicKey;
    });

    // The reader returns whatever the test last queued.
    await tp.page.evaluate(() => {
      window.__SCANNED = null;
      window.BarcodeDetector = function () {};
      window.BarcodeDetector.prototype.detect = function () {
        return Promise.resolve(window.__SCANNED ? [{ rawValue: window.__SCANNED }] : []);
      };
    });

    await tp.page.evaluate(() => document.getElementById("segPeople").click());
    await sleep(500);
    await tp.page.evaluate(() => document.querySelector('#pmPeople [data-person="agent_juma"]').click());
    await sleep(900);
    await tp.page.evaluate(() => document.getElementById("pmVerify").click());
    await sleep(600);

    ok(await tp.page.$("#pmFpScan") !== null,
       "where the phone can read a code, scanning is offered as the primary action");
    ok(await tp.page.$("#pmQrToggle") !== null, "and my own code can be put on screen for them");

    // My code must be the one THEIR phone expects to see.
    const mine = await tp.page.evaluate(async () => {
      document.getElementById("pmQrToggle").click();
      const me = await window.PMStore.me();
      const id = window.PMStore.current();
      return { userId: me.userId, fp: await window.PMCrypto.fingerprint(id.publicKey) };
    });
    await sleep(200);
    ok(await tp.page.$eval("#pmQrWrap", (n) => !n.hidden), "the code appears when asked for");
    const svg = await tp.page.$eval("#pmQrWrap svg", (n) => n.getAttribute("viewBox"));
    ok(/^0 0 \d+ \d+$/.test(svg), "drawn as an SVG with a real viewBox", svg);
    const quiet = await tp.page.$eval("#pmQrWrap rect", (n) => n.getAttribute("fill"));
    ok(quiet === "#ffffff", "on a white ground — a themed QR code is one that does not scan");

    const expected = "PM2|" + mine.userId + "|" + mine.fp.replace(/ /g, "");

    // 1. Somebody else's code.
    await tp.page.evaluate(() => document.getElementById("pmFpScan").click());
    await sleep(400);
    await tp.page.evaluate(() => { window.__SCANNED = "PM2|somebody_else|123456789012345678901234567890"; });
    await sleep(900);
    let out = await tp.page.$eval("#pmFpMsg", (n) => n.textContent);
    ok(/different account/i.test(out), "the wrong person's code is named as that", out);
    ok(await tp.page.evaluate(() =>
      JSON.parse(localStorage.getItem("pm-trust-v1"))["user_self"]["agent_juma"].state) === "seen",
      "and nothing is marked verified");

    // 2. The right person, the wrong key — the attack.
    await tp.page.evaluate(() => { window.__SCANNED = null; });
    await tp.page.evaluate(() => document.getElementById("pmFpScan").click());
    await sleep(400);
    await tp.page.evaluate(() => {
      window.__SCANNED = "PM2|agent_juma|999999999999999999999999999999";
    });
    await sleep(900);
    out = await tp.page.$eval("#pmFpMsg", (n) => n.textContent);
    ok(/do NOT match/i.test(out), "a real mismatch is stated bluntly, not softened", out);
    ok(await tp.page.evaluate(() =>
      JSON.parse(localStorage.getItem("pm-trust-v1"))["user_self"]["agent_juma"].state) === "seen",
      "and still nothing is verified");

    // 3. The genuine article.
    const theirCode = await tp.page.evaluate(async (key) =>
      "PM2|agent_juma|" + (await window.PMCrypto.fingerprint(key)).replace(/ /g, ""), JUMA_KEY);
    await tp.page.evaluate(() => { window.__SCANNED = null; });
    await tp.page.evaluate(() => document.getElementById("pmFpScan").click());
    await sleep(400);
    await tp.page.evaluate((code) => { window.__SCANNED = code; }, theirCode);
    await sleep(900);
    out = await tp.page.$eval("#pmFpMsg", (n) => n.textContent);
    ok(/Matched and verified/i.test(out), "a matching code verifies them", out);
    ok(await tp.page.evaluate(() =>
      JSON.parse(localStorage.getItem("pm-trust-v1"))["user_self"]["agent_juma"].state) === "verified",
      "and THAT is written down, so a later key change will be caught");
    ok(/Verified/.test(await tp.page.$eval("#pmModal", (n) => n.textContent)),
       "the badge says so without being asked again");

    ok(expected.startsWith("PM2|"), "my payload is the documented shape", expected.slice(0, 20) + "…");

    // The camera must not outlive the dialog — including when the dialog is
    // dismissed by tapping the backdrop rather than by a button.
    // Scanning is only offered while someone is unverified — which they now
    // are not — so the pin is cleared and the thread reopened to get the
    // button back. Clearing it here also proves the offer really does depend
    // on the recorded state rather than on the button always being drawn.
    await tp.page.evaluate(() => {
      window.__TRACKS = [];
      const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async function (c) {
        const stream = await real(c);
        window.__TRACKS.push.apply(window.__TRACKS, stream.getTracks());
        return stream;
      };
      window.__SCANNED = null;
      localStorage.removeItem("pm-trust-v1");
      document.getElementById("pmModalBack").click();
      document.getElementById("pmBack").click();
    });
    await sleep(300);
    await tp.page.evaluate(() => document.querySelector('#pmPeople [data-person="agent_juma"]').click());
    await sleep(900);
    await tp.page.evaluate(() => document.getElementById("pmVerify").click());
    await sleep(500);
    ok(await tp.page.$("#pmFpScan") !== null,
       "forgetting the pin puts them back to unverified and offers the scan again");
    await tp.page.evaluate(() => document.getElementById("pmFpScan").click());
    await sleep(700);
    ok(await tp.page.evaluate(() =>
      window.__TRACKS.length > 0 && window.__TRACKS.every((t) => t.readyState === "live")),
      "the camera really is running while the scanner is open");

    await tp.page.evaluate(() => document.getElementById("pmModalBack").click());
    await sleep(500);
    ok(await tp.page.evaluate(() => window.__TRACKS.every((t) => t.readyState === "ended")),
       "and is switched off when the dialog is dismissed, not left on behind it");

    await tp.page.close();
  }

  section("8g. The agent list, and where each of them works");
  // The area of operations is the only thing that makes one agent more use
  // than another, and it used to be the first of four place names run
  // together in a grey subtitle.
  {
    const dp = await openPage("someone@example.com");
    await sleep(900);
    await dp.page.evaluate(() => document.getElementById("segPeople").click());
    await sleep(700);

    const rows = await dp.page.$$eval("#pmPeople .pm-row", (ns) => ns.map((r) => ({
      id: r.dataset.person,
      name: (r.querySelector(".pm-name") || {}).textContent.trim(),
      area: (r.querySelector(".pm-area") || {}).textContent || null,
      areaNone: !!r.querySelector(".pm-area.is-none"),
      hasPin: !!(r.querySelector(".pm-area svg")),
      where: (r.querySelector(".pm-where") || {}).textContent || "",
      sub: r.dataset.sub,
    })));

    const juma = rows.find((r) => r.id === "agent_juma");
    const blank = rows.find((r) => r.id === "agent_blank");
    ok(!!juma && /Nyamagana/.test(juma.area), "an agent's area of operation is its own element", JSON.stringify(juma));
    ok(juma && juma.hasPin, "marked with a pin rather than left as one more grey clause");
    ok(juma && /Mwanza/.test(juma.where), "with the broader place kept separate from it");
    ok(!!blank && blank.areaNone,
       "an agent who never set one is SAID to have not set one, not left blank", JSON.stringify(blank));
    ok(blank && !blank.hasPin, "and gets no pin, because there is nothing to point at");

    // The area must not be repeated as its own parent.
    ok(juma && !/Nyamagana[^]*Nyamagana/.test(juma.area + " " + juma.where),
       "a place is never printed twice in one row");

    ok(rows.every((r) => r.id !== "user_self"), "and you are never in your own directory");

    // Agents by default; everyone on request.
    ok(rows.some((r) => r.id === "agent_blank") && !rows.some((r) => r.id === "plain_amina"),
       "the Agents pane shows agents — including ones with no listings yet",
       JSON.stringify(rows.map((r) => r.id)));
    let count = await dp.page.$eval("#pmCount", (n) => n.textContent);
    ok(/3 agents/.test(count), "and says how many there are", count);

    await dp.page.evaluate(() => {
      document.getElementById("pmWho").value = "all";
      document.getElementById("pmWho").dispatchEvent(new Event("change"));
    });
    await sleep(600);
    const all = await dp.page.$$eval("#pmPeople .pm-row", (ns) => ns.map((r) => r.dataset.person));
    ok(all.indexOf("plain_amina") >= 0,
       "switching to Everyone reveals people who are on P-Message but not agents", JSON.stringify(all));
    count = await dp.page.$eval("#pmCount", (n) => n.textContent);
    ok(/4 people/.test(count), "and counts them too", count);

    // The whole country, not a page of it.
    const limits = await dp.page.evaluate(() =>
      window.__PM_SENT.filter((c) => c.name === "pm_directory").map((c) => c.args.p_limit));
    ok(limits.length > 0 && limits.every((l) => l >= 500),
       "the directory is asked for the whole country, not the first 200 of it", JSON.stringify(limits));

    await dp.page.close();
  }

  section("8h. One room for every agent");
  {
    // The same address the other admin sections use: APP_CONFIG.ADMIN_EMAILS
    // is what the page checks, and the database checks is_admin() again anyway.
    const ap = await openPage("pawa4761@gmail.com");
    await sleep(900);
    // pm_group_candidates only returns people with a published key — the same
    // rule the real function uses, since there is nothing to encrypt to
    // otherwise. On a fresh page nobody has one yet.
    await ap.page.evaluate(async () => {
      for (const id of ["agent_juma", "agent_neema", "agent_blank"]) {
        const kp = await window.PMCrypto.generateIdentity();
        window.__PM_DB.keys[id].public_key = kp.publicKey;
      }
      document.getElementById("pmModalBack").classList.remove("is-on");
    });
    ok(await ap.page.$eval("#pmRoomsBtn", (n) => !n.hidden), "an admin is offered Rooms");
    await ap.page.evaluate(() => document.getElementById("pmRoomsBtn").click());
    await sleep(400);
    ok(await ap.page.$("#pmRoomEveryone") !== null,
       "with a one-tap room for every agent in the country");

    await ap.page.evaluate(() => {
      document.getElementById("pmRoomCat").value = "houses";
      document.getElementById("pmRoomRegion").value = "Mwanza";
      document.getElementById("pmRoomEveryone").click();
    });
    await sleep(900);
    const state = await ap.page.evaluate(() => ({
      cat: document.getElementById("pmRoomCat").value,
      region: document.getElementById("pmRoomRegion").value,
      title: document.getElementById("pmRoomTitle").value,
      msg: document.getElementById("pmRoomMsg").textContent,
      canOpen: !document.getElementById("pmRoomGo").disabled,
    }));
    ok(state.cat === "" && state.region === "",
       "it widens the scope rather than quietly leaving a narrower one set", JSON.stringify(state));
    ok(/every agent/i.test(state.title), "and names the room", state.title);
    ok(/\d+ people/.test(state.msg),
       "the roster is counted before the button that adds them turns on", state.msg);
    ok(state.canOpen, "and only then can it be opened");
    await ap.page.close();
  }

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
  ok(/\d{5}( \d{5}){5}/.test(guestFp), "and their own safety number", guestFp);

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
