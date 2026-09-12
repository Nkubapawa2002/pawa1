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
import { webcrypto } from "crypto";

// A real SPKI public key, generated here so a peer can be REACHABLE from the
// first paint of a fresh page. The ?to= handler runs during boot, long before
// the sections below hand the agents keys of their own. Only the PUBLIC half
// exists in this file; the private half is discarded on the next line and was
// never anybody’s identity.
const PEER_KEY = await (async () => {
  const kp = await webcrypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const spki = Buffer.from(await webcrypto.subtle.exportKey("spki", kp.publicKey));
  return spki.toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
})();

const BASE = "http://localhost:8080";
const SECRET = "Bei ya mwisho 240000 usimwambie mtu";

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; process.stdout.write("  PASS  " + msg + "\n"); }
  else { fail++; process.stdout.write("  FAIL  " + msg + (detail ? "\n        " + detail : "") + "\n"); }
};
const section = (s) => process.stdout.write("\n" + s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for a selector to appear, rather than sleeping long enough that it
 * usually has.
 *
 * The camera-scan section needs this and a fixed sleep cannot give it: the scan
 * modal starts a real MediaStream from Chrome's fake device and then polls the
 * barcode reader every 220ms, so the moment the safety-number dialog comes back
 * depends on how long the video took to start on this machine that day. A sleep
 * tuned to a fast run fails on a slow one and reads as a broken feature.
 * Returns false on timeout so the caller's own assertion is what reports it.
 */
async function waitFor(page, selector, ms) {
  try {
    await page.waitForSelector(selector, { timeout: ms || 8000 });
    return true;
  } catch (_) { return false; }
}

/** The same, for an element that exists all along and gets filled in later. */
async function waitForText(page, selector, ms) {
  try {
    await page.waitForFunction(
      (s) => { const n = document.querySelector(s); return !!n && n.textContent.trim() !== ""; },
      { timeout: ms || 8000 }, selector);
    return true;
  } catch (_) { return false; }
}

// ---- the stub post office ---------------------------------------------------
// Deliberately dumb, exactly like the real schema: it holds ciphertext and
// wrapped keys and has no idea what any of it says.
const MAP_STUB = (globalName) => `(function () {
  function chain() {
    return new Proxy(function () {}, {
      get: function (t, k) {
        if (k === "then") return undefined;
        if (k === Symbol.toPrimitive) return function (h) { return h === "string" ? "" : 0; };
        if (k === "valueOf") return function () { return 0; };
        if (k === "toString") return function () { return ""; };
        if (k === Symbol.iterator) return function () { return [][Symbol.iterator](); };
        return chain();
      },
      set: function () { return true; },
      apply: function () { return chain(); },
      construct: function () { return chain(); },
    });
  }
  window.${globalName} = chain();
})();`;

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
    invites: [],                    // { token_hash, label, state, guest_name, ... }
    listings: {},                   // user_id -> [ storefront rows ]
  };
  // What agent.html draws. Kept beside the keys rather than derived from the
  // counts, because the counts and the catalogue come from two different
  // functions in the real database and a stub that computed one from the
  // other could not catch them disagreeing.
  db.listings["agent_juma"] = [
    { cat: "houses", listing_id: "h-1", title: "Two rooms in Nyamagana", kind: "apartment",
      price_tzs: 250000, unit: "month", photo: null, region: "Mwanza", area: "Nyamagana",
      verified: true, active: true, created_at: new Date().toISOString() },
    { cat: "houses", listing_id: "h-2", title: "Shop on the main road", kind: "shop",
      price_tzs: 900000, unit: "month", photo: null, region: "Mwanza", area: "Nyamagana",
      verified: false, active: true, created_at: new Date().toISOString() },
  ];
  // Two other people already on P-Message, one of them holding a key this
  // device has never seen — that is what makes the "cannot decrypt" path real.
  // The listing counts are what the category chips filter on and what the
  // ranking ranks on, so the two agents deliberately deal in DIFFERENT things:
  // a chip that quietly matched everybody would otherwise look like it worked.
  // A caller that wants the deep-link path needs Juma REACHABLE from the first
  // paint, and keys are normally minted in-page later on. opts.peerKey is a
  // real SPKI public key generated in Node for exactly that.
  db.keys["agent_juma"] = { public_key: ${JSON.stringify(opts && opts.peerKey || "")}, fingerprint: "1111 2222 3333",
    display_name: "Juma Mwanga", region: "Mwanza", is_agent: true, area: "Nyamagana",
    n_houses: 6, n_verified: 2, last_listed_at: new Date().toISOString(),
    // What KIND of work, not just how much of it. The two agents deal in
    // different kinds for the same reason they deal in different categories:
    // a label that matched everybody would look like it worked.
    kinds: ["apartment", "house"],
    // The number this person printed on their own listing. pm_agent_finder
    // reads it off the listing row, never off agent_profiles, so a person with
    // nothing listed has none here either.
    phone: "0712 345 678",
    // Beating right now. Presence is a claim about a person, so the states
    // are seeded rather than derived — one online, one hours ago, one never
    // seen — and the never-seen row must draw NOTHING.
    last_seen_at: new Date().toISOString() };
  db.keys["agent_neema"] = { public_key: "", fingerprint: "4444 5555 6666",
    display_name: "Neema Kileo", region: "Mwanza", is_agent: true, area: "Ilemela",
    n_trucks: 3, last_listed_at: new Date().toISOString(),
    kinds: ["canter", "7ton"],
    // Neema has never published a P-Message key, so a number is the ONLY way
    // to reach her. Her row is the one that proves calling is not merely a
    // second button beside a working first one.
    phone: "+255 754 111 222",
    last_seen_at: new Date(Date.now() - 3 * 3600 * 1000).toISOString() };
  // An agent who never filled in where they work, and a person who is not an
  // agent at all. Both are rows the directory has to render honestly.
  db.keys["agent_blank"] = { public_key: "", fingerprint: "7777 8888 9999",
    display_name: "Rashid Omari", region: "Dodoma", is_agent: true, area: null };
  db.keys["plain_amina"] = { public_key: "", fingerprint: "1212 3434 5656",
    display_name: "Amina Hassan", region: "Mwanza", is_agent: false, area: null };
  // A company that hires by the day. It is deliberately NOT an agent — almost
  // no employer registers as one — which is exactly the row the Day jobs chip
  // used to return and the "Agents" filter then threw away, leaving an empty
  // screen with the right answer one dropdown behind it.
  db.keys["co_kilimo"] = { public_key: "", fingerprint: "2323 4545 6767",
    display_name: "Kilimo Contractors", region: "Mwanza", is_agent: false,
    area: "Nyamagana", n_jobs: 12, last_listed_at: new Date().toISOString() };

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
    // The directory plus what each person deals in — what the Agents pane
    // asks for now, because the category chips and the ranking both need the
    // counts. Filtering by category happens in the database for real, so the
    // stub does it here too: a stub that returned everyone regardless would
    // let a broken filter pass.
    if (name === "pm_agent_finder") {
      return Promise.resolve({ data: Object.keys(db.keys).filter(function (k) { return k !== me; })
        .map(function (k) {
          var v = db.keys[k];
          return { user_id: k, display_name: v.display_name, region: v.region, area: v.area || null,
            area_kind: null, district: null, ward: null, lat: null, lng: null,
            is_agent: v.is_agent, reachable: !!v.public_key,
            public_key: v.public_key, fingerprint: v.fingerprint,
            n_houses: v.n_houses || 0, n_services: v.n_services || 0, n_trucks: v.n_trucks || 0,
            n_jobs: v.n_jobs || 0,
            n_verified: v.n_verified || 0, last_listed_at: v.last_listed_at || null,
            kinds: v.kinds || null, last_seen_at: v.last_seen_at || null,
            phone: v.phone || null };
        })
        .filter(function (r) {
          if (!args.p_region) return true;
          return r.region === args.p_region;
        })
        .filter(function (r) {
          // The ILIKE the real function runs over the name and the three place
          // columns. The stub used to ignore p_query altogether, which was
          // harmless while nothing searched and is not any more: the picker's
          // search box is the thing that makes a hand-picked room possible.
          if (!args.p_query) return true;
          var q = String(args.p_query).toLowerCase();
          return [r.display_name, r.area, r.district, r.ward].some(function (v) {
            return v && String(v).toLowerCase().indexOf(q) >= 0;
          });
        })
        .filter(function (r) {
          if (!args.p_category) return true;
          // Mirrors the CASE in pm_agent_finder, including its last arm: an
          // unknown category matches NOBODY rather than quietly matching all.
          return (args.p_category === "houses" && r.n_houses > 0) ||
                 (args.p_category === "services" && r.n_services > 0) ||
                 (args.p_category === "trucks" && r.n_trucks > 0) ||
                 (args.p_category === "jobs" && r.n_jobs > 0);
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
        // Where they work, which the conversation header shows. It comes back
        // here because pm_peer is the only call the header makes, and a header
        // that knows only a name cannot answer "is this the right person?".
        area: pr.area || null, area_kind: null, district: null, ward: pr.ward || null,
        last_seen_at: pr.last_seen_at || null,
      }], error: null });
    }
    // ---- presence and the storefront ----
    if (name === "pm_online_window") return Promise.resolve({ data: 150, error: null });
    if (name === "pm_touch_seen") {
      db.keys[me] = db.keys[me] || {};
      db.keys[me].last_seen_at = new Date().toISOString();
      return Promise.resolve({ data: db.keys[me].last_seen_at, error: null });
    }
    if (name === "pm_agent_card") {
      var c = db.keys[args.p_user];
      if (!c) return Promise.resolve({ data: [], error: null });
      return Promise.resolve({ data: [{
        user_id: args.p_user, display_name: c.display_name, is_agent: c.is_agent,
        is_guest: !!c.is_guest, reachable: !!c.public_key, region: c.region,
        area: c.area || null, area_kind: null, district: null, ward: null,
        lat: null, lng: null, bio: c.bio || null,
        n_houses: c.n_houses || 0, n_services: c.n_services || 0,
        n_trucks: c.n_trucks || 0, n_jobs: c.n_jobs || 0, n_verified: c.n_verified || 0,
        phone: c.phone || null,
        kinds: c.kinds || null, last_seen_at: c.last_seen_at || null,
        joined_at: new Date(Date.now() - 40 * 86400000).toISOString(),
      }], error: null });
    }
    if (name === "pm_agent_listings") {
      return Promise.resolve({ data: (db.listings[args.p_user] || []), error: null });
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
            // Where they work and what they deal in, because the admin now
            // picks individuals out of the scope rather than taking all of it,
            // and a list of bare names is not something anyone can pick from.
            return { user_id: k, public_key: v.public_key, display_name: v.display_name,
              region: v.region, area: v.area || null, district: null, ward: null,
              is_agent: !!v.is_agent, n_houses: v.n_houses || 0,
              n_services: v.n_services || 0, n_trucks: v.n_trucks || 0,
              n_jobs: v.n_jobs || 0, listings: 1 };
          }),
        error: null,
      });
    }
    if (name === "pm_group_add") {
      var gt = db.threads[args.p_thread];
      var before = (gt.members || []).length;
      (args.p_members || []).forEach(function (u) {
        if (gt.members.indexOf(u) < 0) gt.members.push(u);
      });
      return Promise.resolve({ data: gt.members.length - before, error: null });
    }
    if (name === "pm_group_remove") {
      var rt = db.threads[args.p_thread];
      rt.members = (rt.members || []).filter(function (u) { return u !== args.p_user; });
      return Promise.resolve({ data: null, error: null });
    }
    if (name === "pm_group_leave") {
      var lt = db.threads[args.p_thread];
      if (lt) lt.members = (lt.members || []).filter(function (u) { return u !== me; });
      return Promise.resolve({ data: null, error: null });
    }
    if (name === "pm_thread_size") {
      var st = db.threads[args.p_thread];
      return Promise.resolve({ data: st ? (st.members || []).length : 0, error: null });
    }
    // Revoke MARKS. It used to delete the row here, which quietly made the
    // stub disagree with p_message_invites.sql: the real function sets
    // revoked_at and leaves the row, so a customer opening a withdrawn link is
    // told it was withdrawn rather than that they may have mistyped it. A stub
    // that deleted could never catch a UI that assumed the row disappears.
    if (name === "pm_invite_revoke") {
      (db.invites || []).forEach(function (i) {
        if (i.token_hash === args.p_token_hash) i.state = "revoked";
      });
      return Promise.resolve({ data: null, error: null });
    }
    // Removing a row from the list is the separate act, and the database
    // refuses it on a link that is still open. The stub refuses it too, or a
    // UI that offered Remove on a live link would pass here and lose somebody
    // a credential in production.
    if (name === "pm_invite_forget") {
      var target = (db.invites || []).filter(function (i) { return i.token_hash === args.p_token_hash; })[0];
      if (target && target.state === "open") {
        return Promise.resolve({ data: null, error: { message: "That link is still live. Withdraw it first." } });
      }
      var before = (db.invites || []).length;
      db.invites = (db.invites || []).filter(function (i) { return i.token_hash !== args.p_token_hash; });
      return Promise.resolve({ data: db.invites.length < before, error: null });
    }
    if (name === "pm_invites_clear_finished") {
      var kept = (db.invites || []).filter(function (i) { return i.state === "open"; });
      var went = (db.invites || []).length - kept.length;
      db.invites = kept;
      return Promise.resolve({ data: went, error: null });
    }
    if (name === "pm_group_create") {
      var gid = "room-" + (Object.keys(db.threads).length + 1);
      db.threads[gid] = { kind: "group", title: args.p_title, members: (args.p_members || []).concat([me]) };
      return Promise.resolve({ data: gid, error: null });
    }
    if (name === "pm_invite_create") {
      db.invites = db.invites || [];
      db.invites.unshift({ token_hash: args.p_token_hash, label: args.p_label || null,
        state: "open", thread_id: null, guest_name: null,
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 12096e5).toISOString() });
      return Promise.resolve({
        data: [{ token_hash: args.p_token_hash,
                 expires_at: new Date(Date.now() + 12096e5).toISOString() }],
        error: null,
      });
    }
    // Returns the token HASH, which is what makes a Withdraw button possible
    // at all: pm_invite_revoke takes it, and until the listing returned it no
    // UI could name the link it wanted to withdraw.
    if (name === "pm_invites_mine") return Promise.resolve({ data: db.invites || [], error: null });
    if (name === "pm_thread_keys") {
      var th = db.threads[args.p_thread];
      var members = (th && th.members) || [];
      return Promise.resolve({
        data: members.map(function (u) {
          var v = db.keys[u] || {};
          return { user_id: u, public_key: v.public_key || "", display_name: v.display_name || null,
            role: u === me ? "owner" : "member", is_guest: !!v.is_guest,
            is_agent: !!v.is_agent, region: v.region || null, area: v.area || null,
            area_kind: null, district: null, ward: null,
            joined_at: new Date().toISOString() };
        }).filter(function (r) { return r.public_key; }),
        error: null,
      });
    }
    if (name === "pm_send") {
      var mid = "m" + (db.messages.length + 1);
      db.messages.push({ id: mid, thread_id: args.p_thread, sender_id: me,
        iv: args.p_iv, ciphertext: args.p_ciphertext,
        // Only the id. The stub stores what the real column stores, so a page
        // that started shipping the quoted TEXT to the server would have
        // nowhere to put it and the assertion below would catch it.
        reply_to: args.p_reply_to || null, sent_at: new Date().toISOString() });
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
            sender_guest: !!(db.keys[m.sender_id] || {}).is_guest,
            alg: m.alg || null, iv: m.iv, ciphertext: m.ciphertext,
            epk: w ? w.epk : null, wrapped_key: w ? w.wrapped_key : null,
            generation: isSk ? m.generation : null, seq: isSk ? m.seq : null,
            reply_to: m.reply_to || null,
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
        generation: args.p_generation, seq: args.p_seq,
        reply_to: args.p_reply_to || null, sent_at: new Date().toISOString() });
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
    // ---- the audience fences ------------------------------------------------
    // Modelled rather than waved through, because the picker's whole job is
    // drawing the answers these give. A stub that said "yes" to everything
    // would let a screen that offers a stranger an advert pass the suite.
    function isBlocked(u) {
      db.blocks = db.blocks || [];
      return db.blocks.indexOf(u) >= 0;
    }
    // Somebody I have actually dealt with: a DIRECT thread we are both in and
    // we have both written in. A room grants nothing, and neither does a
    // thread only one of us has spoken in.
    function contacts() {
      var out = {};
      Object.keys(db.threads).forEach(function (id) {
        var th = db.threads[id];
        if (th.kind !== "direct") return;
        var mine = db.messages.some(function (m) { return m.thread_id === id && m.sender_id === me; });
        (th.members || []).forEach(function (u) {
          if (u === me || isBlocked(u)) return;
          var theirs = db.messages.some(function (m) { return m.thread_id === id && m.sender_id === u; });
          if (mine && theirs) out[u] = true;
        });
      });
      return out;
    }
    function listed(u) {
      var v = db.keys[u] || {};
      return !!v.is_agent || !!(v.n_houses || v.n_services || v.n_trucks || v.n_jobs);
    }
    if (name === "pm_my_people") {
      var mineSet = contacts();
      var q = String(args.p_query || "").toLowerCase();
      return Promise.resolve({
        data: Object.keys(mineSet).filter(function (k) {
          var v = db.keys[k] || {};
          return !q || String(v.display_name || "").toLowerCase().indexOf(q) >= 0;
        }).map(function (k) {
          var v = db.keys[k];
          return { user_id: k, display_name: v.display_name, region: v.region,
            area: v.area || null, area_kind: null, district: null, ward: null,
            wards: [], districts: [], lat: null, lng: null,
            is_agent: !!v.is_agent, reachable: !!v.public_key, public_key: v.public_key,
            fingerprint: v.fingerprint || null,
            n_houses: v.n_houses || 0, n_services: v.n_services || 0,
            n_trucks: v.n_trucks || 0, n_jobs: v.n_jobs || 0, n_verified: 0,
            last_listed_at: null, last_seen_at: v.last_seen_at || null,
            kinds: v.kinds || [], phone: null, how: "thread" };
        }), error: null });
    }
    if (name === "pm_audience_check") {
      var known = contacts();
      // The admin arm, which the real function has: is_admin() short-circuits
      // the reach test but NOT the block. Without it every row on an admin's
      // screen would be greyed and the sections that drive the picker would be
      // measuring the stub rather than the page.
      var amAdmin = ${JSON.stringify(/^pawa4761@gmail\.com$/i.test(String(email || "")))};
      return Promise.resolve({
        data: (args.p_users || []).map(function (u) {
          var cast = !isBlocked(u) && (amAdmin || !!known[u]);
          return { user_id: u, may_cast: cast, may_room: cast || (!isBlocked(u) && listed(u)) };
        }), error: null });
    }
    // Saved lists. Modelled rather than waved through for the same reason the
    // reach check is: pm_list_people answers may_cast / may_room per row, and
    // a stub that said yes to everything would let a screen that offers a
    // stranger an advert pass the suite.
    if (name === "pm_list_create") {
      db.lists = db.lists || [];
      var lid = "list-" + (db.lists.length + 1);
      db.lists.push({ id: lid, name: args.p_name, members: (args.p_members || []).slice() });
      return Promise.resolve({ data: lid, error: null });
    }
    if (name === "pm_lists_mine") {
      return Promise.resolve({ data: (db.lists || []).map(function (l) {
        return { id: l.id, name: l.name, n_members: l.members.length,
          updated_at: new Date().toISOString() };
      }), error: null });
    }
    if (name === "pm_list_set") {
      var setL = (db.lists || []).filter(function (l) { return l.id === args.p_list; })[0];
      if (setL) setL.members = (args.p_members || []).slice();
      return Promise.resolve({ data: setL ? setL.members.length : 0, error: null });
    }
    if (name === "pm_list_delete") {
      db.lists = (db.lists || []).filter(function (l) { return l.id !== args.p_list; });
      return Promise.resolve({ data: true, error: null });
    }
    if (name === "pm_list_people") {
      var pl = (db.lists || []).filter(function (l) { return l.id === args.p_list; })[0];
      var kn = contacts();
      var amAdm = ${JSON.stringify(/^pawa4761@gmail\.com$/i.test(String(email || "")))};
      return Promise.resolve({ data: (pl ? pl.members : []).map(function (u) {
        var v = db.keys[u] || {};
        var castOk = !isBlocked(u) && (amAdm || !!kn[u]);
        return { user_id: u, display_name: v.display_name, region: v.region,
          area: v.area || null, area_kind: null, district: null, ward: null,
          wards: [], districts: [], lat: null, lng: null,
          is_agent: !!v.is_agent, reachable: !!v.public_key, public_key: v.public_key,
          fingerprint: v.fingerprint || null,
          n_houses: v.n_houses || 0, n_services: v.n_services || 0,
          n_trucks: v.n_trucks || 0, n_jobs: v.n_jobs || 0, n_verified: 0,
          last_listed_at: null, last_seen_at: v.last_seen_at || null,
          kinds: v.kinds || [], phone: null,
          may_cast: castOk, may_room: castOk || (!isBlocked(u) && listed(u)) };
      }), error: null });
    }
    if (name === "pm_block") {
      db.blocks = db.blocks || [];
      if (db.blocks.indexOf(args.p_user) < 0) db.blocks.push(args.p_user);
      return Promise.resolve({ data: true, error: null });
    }
    if (name === "pm_unblock") {
      db.blocks = (db.blocks || []).filter(function (u) { return u !== args.p_user; });
      return Promise.resolve({ data: true, error: null });
    }
    // The server half of a block that reaches an EXISTING conversation. It
    // mirrors p_message_hush.sql: false for a direct thread either side has
    // blocked, and it deliberately does NOT silence a room, because one member
    // must not be able to switch a room off for everybody.
    if (name === "pm_can_speak") {
      var th = db.threads[args.p_thread];
      if (!th || th.kind !== "direct") return Promise.resolve({ data: true, error: null });
      var otherSide = (th.members || []).filter(function (u) { return u !== me; })[0];
      return Promise.resolve({
        data: !otherSide || (db.blocks || []).indexOf(otherSide) < 0, error: null });
    }
    if (name === "pm_blocks_mine") {
      return Promise.resolve({ data: (db.blocks || []).map(function (u) {
        return { user_id: u, display_name: (db.keys[u] || {}).display_name || u,
          region: (db.keys[u] || {}).region || null, blocked_at: new Date().toISOString() };
      }), error: null });
    }
    // pm_broadcast had NO entry here at all: it fell through to the null
    // return, so every assertion about an announcement was counting a call
    // that stored nothing. It stores a thread now, so "who did this reach"
    // is a question the suite can actually ask.
    if (name === "pm_broadcast") {
      var castId = args.p_thread || ("cast-" + Object.keys(db.threads).length);
      db.threads[castId] = {
        kind: "broadcast", title: args.p_title || "Announcement", region: args.p_region || null,
        members: [me].concat((args.p_keys || []).map(function (k) { return k.user_id; })),
      };
      return Promise.resolve({ data: castId, error: null });
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
    // Realtime, recorded rather than faked away. Which channels were opened is
    // the only evidence that the page watches the whole inbox and not just the
    // conversation in front of it, and __PM_FIRE_INSERT lets a test play the
    // part of somebody else sending a message.
    channel: function (name) {
      window.__PM_CHANNELS = window.__PM_CHANNELS || [];
      window.__PM_CHANNELS.push(name);
      var handlers = [];
      var ch = {
        on: function (_ev, _filter, fn) { handlers.push(fn); return ch; },
        subscribe: function () { return ch; },
      };
      window.__PM_HANDLERS = (window.__PM_HANDLERS || []).concat([handlers]);
      window.__PM_FIRE_INSERT = function (row) {
        (window.__PM_HANDLERS || []).forEach(function (hs) {
          hs.forEach(function (fn) { try { fn({ new: row || {} }); } catch (_) {} });
        });
      };
      return ch;
    },
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
    if (/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(url) ||
        /cdn\.jsdelivr\.net.*(leaflet|maplibre).*\.css/.test(url)) {
      return req.respond({ status: 200, headers: { "content-type": "text/css" }, body: "" });
    }
    // Leaflet, for the map sheet a place message opens. Nothing here opens it;
    // what matters is that the blocking <script> resolves so the page loads.
    if (/cdn\.jsdelivr\.net.*(leaflet|maplibre)/.test(url)) {
      return req.respond({ status: 200,
        headers: { "content-type": "application/javascript" },
        body: MAP_STUB(/leaflet/.test(url) ? "L" : "maplibregl") });
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
  await page.goto(`${BASE}/${(opts && opts.path) || "p-message.html"}`,
                  { waitUntil: "domcontentloaded", timeout: 30000 });
  await sleep(1600);
  return { page, errs, bodies };
}

try {
  section("1. Setting up on a new device");
  const { page, errs, bodies } = await openPage("someone@example.com");

  ok(await page.$eval("#pmLockText", (n) => n.textContent).then((t) => /encrypted/i.test(t)),
     "the header says the conversations are end-to-end encrypted");
  // The header chip used to PRINT the thirty digits, in 11px muted mono, on a
  // line with no room: it wrapped mid-number, which is the one thing a safety
  // number must not do, and it opened the BACKUP dialog. So the assertion is
  // now about the door rather than about the text on it, and the digits are
  // checked where they are actually legible.
  const fp = await page.$eval("#pmFpBtn", (n) => ({ hidden: n.hidden, text: n.textContent.trim() }));
  ok(!fp.hidden && /safety number|namba/i.test(fp.text),
     "a safety number was generated, and the header offers a way to it", fp.text);

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

  // And the header chip goes to the OTHER key dialog. Checked here rather than
  // in section 1 because the first-run backup modal is open until the line
  // above dismisses it, and opening a second dialog over it would be testing
  // this one by breaking that one.
  await page.evaluate(() => document.getElementById("pmFpBtn").click());
  await sleep(400);
  const fpDlg = await page.evaluate(() => {
    const g = document.querySelector("#pmModal .pm-big-fp");
    return { open: document.getElementById("pmModalBack").classList.contains("is-on"),
             digits: g ? g.textContent.trim() : "",
             cells: g ? g.querySelectorAll("span").length : 0,
             isBackup: !!document.getElementById("pmBkPass") };
  });
  ok(fpDlg.open && /^\d{5}( \d{5}){5}$/.test(fpDlg.digits) && fpDlg.cells === 6,
     "and it opens on the full thirty digits, six groups over three columns",
     JSON.stringify(fpDlg));
  // The chip is named "Your safety number". It used to open "Save a backup
  // code", which is a different key ritual with a different consequence, and
  // on this screen more than any other a button has to open its own label.
  ok(!fpDlg.isBackup, "and not on the backup dialog, which is a different thing entirely");
  await page.evaluate(() => document.getElementById("pmFpOk").click());
  await sleep(250);

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

  section("3b. The Day jobs chip — the fourth category, and the filter that hid it");
  // The claim under test is not "a chip exists". It is that choosing a
  // category returns the people who have evidence in THAT category and nobody
  // else, and that the agent flag no longer subtracts from a measurement it
  // was only ever a proxy for.
  const pickCat = async (cat) => {
    await page.evaluate((c) => {
      document.querySelector('#pmCats [data-cat="' + c + '"]').click();
    }, cat);
    await sleep(900);
    return page.$$eval("#pmPeople .pm-row", (n) => n.map((r) => ({
      id: r.dataset.person || "",
      name: (r.querySelector(".pm-name") || {}).textContent.trim(),
      deals: Array.from(r.querySelectorAll(".pm-deal")).map((d) => d.textContent.trim()).join(" | "),
    })));
  };

  ok(await page.$('#pmCats [data-cat="jobs"]'), "there is a Day jobs chip at all");

  const jobRows = await pickCat("jobs");
  ok(jobRows.some((r) => r.id === "co_kilimo"),
     "a company that posts day jobs is found by the Day jobs chip",
     JSON.stringify(jobRows.map((r) => r.name)));
  ok(!jobRows.some((r) => r.id === "agent_juma" || r.id === "agent_neema"),
     "and the house and truck agents are not, because they have posted none",
     JSON.stringify(jobRows.map((r) => r.name)));
  ok(/12/.test((jobRows.find((r) => r.id === "co_kilimo") || {}).deals || ""),
     "the row says how many, not merely that there are some",
     (jobRows.find((r) => r.id === "co_kilimo") || {}).deals);
  ok(/post/i.test((jobRows.find((r) => r.id === "co_kilimo") || {}).deals || ""),
     "worded as something they posted rather than something they own",
     (jobRows.find((r) => r.id === "co_kilimo") || {}).deals);

  // The regression this guards: "Agents" is the default in #pmWho, the company
  // is not an agent, and before this change the two filters ANDed together to
  // produce an empty list for a chip that had matches.
  ok(await page.$eval("#pmWho", (n) => n.value) === "agents",
     "with the Who filter still on its Agents default");
  ok(jobRows.length > 0, "the chip is not silently emptied by that default");

  const truckRows = await pickCat("trucks");
  ok(truckRows.some((r) => r.id === "agent_neema") && !truckRows.some((r) => r.id === "co_kilimo"),
     "the other categories still filter to their own people",
     JSON.stringify(truckRows.map((r) => r.name)));

  const anyRows = await pickCat("");
  ok(anyRows.length >= truckRows.length,
     "and Anyone is still the widest list", `${anyRows.length} >= ${truckRows.length}`);
  // This assertion is the REVERSE of what it used to be, and the reversal is
  // the point. The old rule was "is_agent, unless a chip is on"; the exception
  // existed because the flag threw away the exact people a chip was for. The
  // same subtraction was happening with no chip on, silently, to the same
  // people — a company that hires by the day, a landlord who never registered.
  // Evidence beats a flag everywhere now, so a company with twelve posted jobs
  // is in the list whether or not it ticked a box.
  ok(anyRows.some((r) => r.id === "co_kilimo"),
     "and a company that posts day jobs is in the list without a chip too, because listings are evidence and the agent flag is only a proxy",
     JSON.stringify(anyRows.map((r) => r.name)));

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
  const aiBadge = await page.$eval("#pmAiRow .pz-hero-name .pm-badge", (n) => n.textContent);
  ok(/not encrypted/i.test(aiBadge), "and the badge beside its name says so too", aiBadge);

  await page.evaluate(() => document.querySelector('#pmAiRow [data-pz="open"]')?.click());
  await sleep(500);
  const aiLock = await page.$eval("#pmLockText", (n) => n.textContent);
  ok(/not encrypted/i.test(aiLock),
     "and opening it FLIPS the header lock — the two kinds of thread never look alike", aiLock);
  const aiNote = await page.$eval("#pmConvNote", (n) => n.textContent);
  ok(/PN-Zaki reads/i.test(aiNote), "with the reason stated in the composer", aiNote);

  section("8. Announcing is for accounts, not for admins");
  // This assertion is the INVERSE of what it used to be, and the inversion is
  // the feature. Announcing was gated on one email in ADMIN_EMAILS; it is
  // gated on the RECIPIENT now (pm_may_cast_to), so an ordinary account gets
  // the button and the fence lives per person inside the picker and inside the
  // database. Asserted on what is DRAWN, not on the attribute: [hidden] is
  // only a UA display:none and any author display rule silently beats it.
  ok(await page.$eval("#pmBroadcastBtn", (n) => getComputedStyle(n).display !== "none"),
     "an ordinary account gets the announce button now");
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
  ok(await admin.page.$eval("#pmBroadcastBtn", (n) => getComputedStyle(n).display !== "none"), "the admin does too");
  await admin.page.click("#pmBroadcastBtn");
  await sleep(500);
  // The region select is now INSIDE the picker, where it narrows a search
  // rather than defining the audience. The audience is the basket.
  const scopes = await admin.page.$$eval("#pmPkRegion option", (n) => n.map((o) => o.textContent));
  ok(scopes.length > 5, "the picker can still narrow to one region", scopes.slice(0, 3).join(" / "));
  ok(await admin.page.$("#pmCastBody") !== null, "with a message to write");
  // Send is off until somebody is chosen, and there is no longer a separate
  // "who would get this?" step that could go stale against the selects.
  ok(await admin.page.$eval("#pmCastGo", (n) => n.disabled),
     "and nothing can be sent until somebody is actually chosen");
  ok(await admin.page.$("#pmCastWho") === null,
     "the two-step preview is gone: the basket IS the preview, so it cannot disagree with the send");
  if (process.argv.includes("--shot")) {
    await admin.page.screenshot({ path: "tests/shot_pmessage_announce.png" });
  }

  section("8b. Opening a room, one person at a time");
  await admin.page.evaluate(() => { document.getElementById("pmModalBack").classList.remove("is-on"); });
  ok(await admin.page.$eval("#pmRoomsBtn", (n) => getComputedStyle(n).display !== "none"),
     "a Rooms button");
  await admin.page.evaluate(() => document.getElementById("pmRoomsBtn").click());
  await sleep(600);
  const cats = await admin.page.$$eval("#pmPkCat option", (n) => n.map((o) => o.value));
  ok(cats.join(",") === ",houses,services,trucks,jobs",
     "the picker still narrows by what people deal in, all four categories, jobs included",
     cats.join(","));
  // The safety rail moved rather than went: you cannot open a room until you
  // have chosen the people in it, and the people are what you chose rather
  // than whoever a scope happened to catch.
  ok(await admin.page.$eval("#pmRoomGo", (n) => n.disabled),
     "and the room cannot be opened until somebody is in it");
  // Nobody has a published key on a fresh page, and the picker will not offer
  // somebody there is nothing to encrypt to. Mint some first, or "All" would
  // correctly tick nobody and the assertion would be measuring the fixture.
  await admin.page.evaluate(async () => {
    for (const id of ["agent_juma", "agent_neema", "agent_blank"]) {
      const kp = await window.PMCrypto.generateIdentity();
      window.__PM_DB.keys[id].public_key = kp.publicKey;
    }
  });
  // Switch to Everyone and take all of them. This is what the old "Every
  // agent in Tanzania" button did, and it now works against any search.
  await admin.page.evaluate(() => document.querySelector('[data-src="all"]').click());
  await sleep(900);
  await admin.page.evaluate(() => document.querySelector('#pmPkHead [data-all="1"]').click());
  await sleep(300);
  const chosen = await admin.page.$eval("#pmPkBasket", (n) => n.textContent);
  ok(/\d/.test(chosen), "choosing All fills the basket", chosen.slice(0, 70));
  ok(await admin.page.$eval("#pmRoomGo", (n) => !n.disabled),
     "and only then does Open room mean anything");
  // Layout is easier to judge by eye than by assertion, and this run already
  // has the picker in a realistic state: three rows, a full basket, one of
  // them greyed with its reason.
  if (process.argv.includes("--shot")) {
    const theme = process.argv.includes("--light") ? "light" : "dark";
    await admin.page.evaluate((th) => {
      localStorage.setItem("pawa-theme", th);
      document.documentElement.setAttribute("data-theme", th);
    }, theme);
    await sleep(400);
    await admin.page.evaluate(() => {
      const l = document.getElementById("pmPkList");
      if (l) l.scrollTop = l.scrollHeight;
    });
    await sleep(200);
    await admin.page.screenshot({ path: `tests/shot_pm_picker_${theme}.png` });
    process.stdout.write(`  (picker screenshot written: ${theme})\n`);
  }

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
    await waitFor(tp.page, "#pmScanVid");
    await tp.page.evaluate(() => { window.__SCANNED = "PM2|somebody_else|123456789012345678901234567890"; });
    ok(await waitForText(tp.page, "#pmFpMsg"), "the scan comes back with a verdict");
    let out = await tp.page.$eval("#pmFpMsg", (n) => n.textContent);
    ok(/different account/i.test(out), "the wrong person's code is named as that", out);
    ok(await tp.page.evaluate(() =>
      JSON.parse(localStorage.getItem("pm-trust-v1"))["user_self"]["agent_juma"].state) === "seen",
      "and nothing is marked verified");

    // 2. The right person, the wrong key — the attack.
    await tp.page.evaluate(() => { window.__SCANNED = null; });
    await tp.page.evaluate(() => document.getElementById("pmFpScan").click());
    await waitFor(tp.page, "#pmScanVid");
    await tp.page.evaluate(() => {
      window.__SCANNED = "PM2|agent_juma|999999999999999999999999999999";
    });
    await waitForText(tp.page, "#pmFpMsg");
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
    await waitFor(tp.page, "#pmScanVid");
    await tp.page.evaluate((code) => { window.__SCANNED = code; }, theirCode);
    await waitForText(tp.page, "#pmFpMsg");
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

    // Everyone with something to offer by default; everyone on request.
    ok(rows.some((r) => r.id === "agent_blank") && !rows.some((r) => r.id === "plain_amina"),
       "the pane shows registered agents, including ones with no listings yet, and not somebody who merely opened P-Message",
       JSON.stringify(rows.map((r) => r.id)));
    ok(rows.some((r) => r.id === "co_kilimo"),
       "and somebody who never registered but has listings, because that is an agent in the only sense this screen cares about",
       JSON.stringify(rows.map((r) => r.id)));
    let count = await dp.page.$eval("#pmCount", (n) => n.textContent);
    // "4 agents" would be a lie about a list holding a construction firm that
    // never registered as one. The word follows the rows on screen.
    ok(/4 people/.test(count), "and says how many there are, in a word that fits them", count);

    await dp.page.evaluate(() => {
      document.getElementById("pmWho").value = "all";
      document.getElementById("pmWho").dispatchEvent(new Event("change"));
    });
    await sleep(600);
    const all = await dp.page.$$eval("#pmPeople .pm-row", (ns) => ns.map((r) => r.dataset.person));
    ok(all.indexOf("plain_amina") >= 0,
       "switching to Everyone reveals people who are on P-Message but not agents", JSON.stringify(all));
    count = await dp.page.$eval("#pmCount", (n) => n.textContent);
    // Four people plus the day-job company, which is on P-Message and not an
    // agent — exactly what "Everyone" is supposed to reveal.
    ok(/5 people/.test(count), "and counts them too", count);

    // The whole country, not a page of it. (pm_agent_finder is what the pane
    // asks now — same question, plus what each person deals in.)
    const limits = await dp.page.evaluate(() =>
      window.__PM_SENT.filter((c) => c.name === "pm_agent_finder").map((c) => c.args.p_limit));
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
    await sleep(600);

    // "Every agent in Tanzania" used to be its own button, and it was the only
    // way to reach the room an admin wanted most often: leaving both selects
    // alone. It is now the general case of the picker rather than a special
    // case beside it. Empty search, source Everyone, All.
    await ap.page.evaluate(() => document.querySelector('[data-src="all"]').click());
    await sleep(900);
    await ap.page.evaluate(() => document.querySelector('#pmPkHead [data-all="1"]').click());
    await sleep(300);

    const state = await ap.page.evaluate(() => ({
      shown: document.getElementById("pmPkShown").textContent,
      basket: document.getElementById("pmPkBasket").textContent,
      chips: document.querySelectorAll("#pmPkBasket .pm-chip").length,
      canOpen: !document.getElementById("pmRoomGo").disabled,
      go: document.getElementById("pmRoomGo").textContent,
    }));
    ok(/\d+ people/.test(state.shown),
       "the roster is counted before the button that adds them turns on", state.shown);
    ok(state.chips >= 2, "and every one of them is in the basket", JSON.stringify(state));
    ok(state.canOpen, "so the room can be opened");
    // The count is ON the button. A room is a thing you cannot un-send, and
    // "Open room" says nothing about how many people that is.
    ok(/\d/.test(state.go), "and the button says how many people that is", state.go);

    // Narrowing is the other half: the same picker, one search box, and the
    // room becomes three people instead of all of them. This is the thing the
    // two selects could never do.
    await ap.page.evaluate(() => {
      document.querySelector('#pmPkHead [data-all="0"]').click();
      const q = document.getElementById("pmPkQ");
      q.value = "Juma";
      q.dispatchEvent(new Event("input"));
    });
    await sleep(1200);
    const narrowed = await ap.page.$$eval("#pmPkList .pm-pick .pm-mem-nm",
      (n) => n.map((x) => x.textContent.trim()));
    ok(narrowed.length >= 1 && narrowed.every((s) => /juma/i.test(s)),
       "searching a name narrows the list to that person", narrowed.join(" / "));
    await ap.page.close();
  }

  section("8i. You choose who is in the room, and the choice is the room");
  {
    // A room's membership used to BE its scope: the screen handed
    // pm_group_create every candidate the selects returned, so somebody who
    // wanted three of the four people in Mwanza had no way to say so. The RPC
    // has always taken an explicit list; only the screen collapsed the two.
    const ap = await openPage("pawa4761@gmail.com");
    await sleep(900);
    await ap.page.evaluate(async () => {
      for (const id of ["agent_juma", "agent_neema", "agent_blank"]) {
        const kp = await window.PMCrypto.generateIdentity();
        window.__PM_DB.keys[id].public_key = kp.publicKey;
      }
      document.getElementById("pmModalBack").classList.remove("is-on");
      document.getElementById("pmRoomsBtn").click();
    });
    await sleep(400);
    await ap.page.evaluate(() => document.querySelector('[data-src="all"]').click());
    await sleep(900);

    const picker = await ap.page.evaluate(() => ({
      boxes: document.querySelectorAll("#pmPkList .pm-pick input").length,
      ticked: document.querySelectorAll("#pmPkList .pm-pick input:checked").length,
      areas: Array.from(document.querySelectorAll("#pmPkList .pm-area span"))
        .map((n) => n.textContent),
    }));
    ok(picker.boxes >= 3, "every candidate is a row", JSON.stringify(picker.boxes));
    // This assertion INVERTS the old one, and the inversion is the point. The
    // old picker started with everybody ticked because a scope was a good
    // default. There is no scope now: a hand-picked room is not everyone minus
    // three, so it starts empty and All is one tap away.
    ok(picker.ticked === 0,
       "and none of them is ticked to start with: the room is what you chose, not what a scope caught");
    // The reason a picker is usable at all: a list of bare names is not
    // something anybody can make a decision about.
    ok(picker.areas.some((a) => /Nyamagana|Ilemela/.test(a)),
       "each row says where that person works", JSON.stringify(picker.areas));
    ok(picker.areas.some((a) => /not set/i.test(a)),
       "and somebody who never filled it in is SAID to have not filled it in");

    // Take all of them, put one back, open the room, and check the one that
    // was put back is not in the members the RPC was given.
    const dropped = await ap.page.evaluate(() => {
      document.querySelector('#pmPkHead [data-all="1"]').click();
      const boxes = document.querySelectorAll("#pmPkList .pm-pick input:not(:disabled)");
      boxes[0].checked = false;
      boxes[0].dispatchEvent(new Event("change", { bubbles: true }));
      document.getElementById("pmRoomTitle").value = "Mwanza rooms";
      return boxes[0].value;
    });
    await sleep(300);
    const chips = await ap.page.evaluate(() =>
      document.querySelectorAll("#pmPkBasket .pm-chip").length);
    ok(chips >= 1, "the basket holds the rest", String(chips));

    await ap.page.evaluate(() => document.getElementById("pmRoomGo").click());
    await sleep(900);
    const created = await ap.page.evaluate(() =>
      (window.__PM_SENT || []).filter((c) => c.name === "pm_group_create").pop());
    ok(created && created.args.p_members.indexOf(dropped) < 0,
       "and the person who was unticked is not put in the room",
       JSON.stringify(created && created.args.p_members));
    ok(created && created.args.p_members.length === chips,
       "while everyone still in the basket is, exactly and only",
       JSON.stringify([created && created.args.p_members.length, chips]));
    // The scope labels are no longer written from two selects that may have
    // had nothing to do with who was ticked. A label that can lie about the
    // membership is worse than no label.
    ok(created && created.args.p_category === null && created.args.p_region === null,
       "and the room is not stamped with a scope it does not actually have",
       JSON.stringify(created && [created.args.p_category, created.args.p_region]));
    ok(ap.errs.length === 0, "no page errors while picking", ap.errs.slice(0, 3).join("\n        "));
    await ap.page.close();
  }

  section("8j. A room you can see into — and change");
  {
    // #pmMembers has been in the markup since rooms shipped and was never
    // wired to anything, so pm_group_add / _remove / _leave were unreachable:
    // an admin could open a room of two hundred people and then never change
    // it, and a member could never leave one.
    const ap = await openPage("pawa4761@gmail.com");
    await sleep(900);
    await ap.page.evaluate(async () => {
      window.confirm = () => true;          // the roster asks before it acts
      for (const id of ["agent_juma", "agent_neema", "agent_blank"]) {
        const kp = await window.PMCrypto.generateIdentity();
        window.__PM_DB.keys[id].public_key = kp.publicKey;
      }
      window.__PM_DB.threads["room-x"] = { kind: "group", title: "Mwanza rooms",
        members: ["agent_juma", "agent_neema", "user_self"] };
      document.getElementById("pmModalBack").classList.remove("is-on");
      document.getElementById("segChats").click();
      // The list is live now, so the way to make a new thread appear is to let
      // the page hear about it rather than to reload — which is also the thing
      // 8m asserts in its own right.
      if (window.__PM_FIRE_INSERT) window.__PM_FIRE_INSERT();
    });
    await sleep(900);
    await ap.page.evaluate(() => {
      const row = document.querySelector('#pmInbox [data-kind="group"]');
      if (row) row.click();
    });
    await sleep(800);

    const header = await ap.page.evaluate(() => ({
      members: !document.getElementById("pmMembers").hidden,
      verify: !document.getElementById("pmVerify").hidden,
      label: document.getElementById("pmMembers").textContent,
    }));
    ok(header.members, "a room offers Members");
    ok(!header.verify,
       "and not Verify — a room has no single other person whose number could be compared");
    ok(/\d+ members/.test(header.label), "the button says how many people are in it", header.label);

    await ap.page.evaluate(() => document.getElementById("pmMembers").click());
    await sleep(800);
    const roster = await ap.page.evaluate(() => ({
      rows: document.querySelectorAll("#pmMemList .pm-mem").length,
      names: Array.from(document.querySelectorAll("#pmMemList .pm-mem-nm")).map((n) => n.textContent),
      areas: Array.from(document.querySelectorAll("#pmMemList .pm-area span")).map((n) => n.textContent),
      canRemove: document.querySelectorAll("#pmMemList [data-remove]").length,
      canAdd: !!document.getElementById("pmMemAdd"),
      canLeave: !!document.getElementById("pmMemLeave"),
    }));
    ok(roster.rows === 3, "the roster lists everybody in the room", String(roster.rows));
    ok(roster.names.some((n) => /Juma/.test(n)), "by name", JSON.stringify(roster.names));
    // The whole reason to open a roster in a room of eighty agents.
    ok(roster.areas.some((a) => /Nyamagana/.test(a)),
       "and by WHERE THEY WORK", JSON.stringify(roster.areas));
    ok(roster.names.some((n) => /\(you\)/.test(n)), "marking which one is you");
    ok(roster.canAdd && roster.canLeave, "the owner is offered Add people, and anyone can leave");
    ok(roster.canRemove === 2,
       "with Remove on everyone but the owner — pm_group_remove refuses an owner, so the button is not drawn",
       String(roster.canRemove));

    await ap.page.evaluate(() => document.querySelector("#pmMemList [data-remove]").click());
    await sleep(900);
    const removed = await ap.page.evaluate(() =>
      (window.__PM_SENT || []).filter((c) => c.name === "pm_group_remove").pop());
    ok(!!removed, "removing somebody calls pm_group_remove", JSON.stringify(removed && removed.args));
    const shrunk = await ap.page.evaluate(() =>
      document.querySelectorAll("#pmMemList .pm-mem").length);
    ok(shrunk === 2, "and the roster is redrawn from the database, not from the page", String(shrunk));

    await ap.page.evaluate(() => document.getElementById("pmMemAdd").click());
    await sleep(500);
    ok(await ap.page.$("#pmAddPick .pm-pk") !== null, "adding people opens the same picker");
    await ap.page.evaluate(() => document.querySelector('[data-src="all"]').click());
    await sleep(900);
    const addable = await ap.page.evaluate(() =>
      Array.from(document.querySelectorAll("#pmPkList .pm-pick input")).map((i) => i.value));
    // agent_juma was the one just removed, so it SHOULD be offered again;
    // agent_neema is still in the room and should not be. Ticking somebody
    // already in it would end in "you added 4 people" and 2 actually added.
    ok(addable.indexOf("agent_neema") < 0,
       "and somebody already in the room is not offered again", JSON.stringify(addable));
    ok(addable.indexOf("agent_juma") >= 0,
       "while somebody who was removed can be put back");

    await ap.page.evaluate(() => {
      document.querySelector('#pmPkHead [data-all="1"]').click();
    });
    await sleep(300);
    await ap.page.evaluate(() => document.getElementById("pmAddGo").click());
    await sleep(900);
    const added = await ap.page.evaluate(() =>
      (window.__PM_SENT || []).filter((c) => c.name === "pm_group_add").pop());
    ok(!!added && added.args.p_members.length > 0, "the chosen people are added",
       JSON.stringify(added && added.args.p_members));

    await sleep(900);
    await ap.page.evaluate(() => document.getElementById("pmMemLeave").click());
    await sleep(900);
    const left = await ap.page.evaluate(() => ({
      called: (window.__PM_SENT || []).some((c) => c.name === "pm_group_leave"),
      convOpen: document.getElementById("pmConv").classList.contains("is-on"),
    }));
    ok(left.called, "and leaving calls pm_group_leave");
    ok(!left.convOpen, "closing the conversation, because it is not yours any more");
    ok(ap.errs.length === 0, "no page errors in the roster", ap.errs.slice(0, 3).join("\n        "));
    await ap.page.close();
  }

  section("8k. The links an agent has out there");
  {
    //  A link is a bearer credential: whoever opens it first becomes the
    //  customer in that thread. So this list exists to answer one question,
    //  "what is still out there", and for a long time it could not:
    //
    //    · nothing could be withdrawn, because pm_invites_mine did not return
    //      the token hash the revoke RPC needs to name a link;
    //    · then nothing could be REMOVED, so a link withdrawn in March sat
    //      above the two that were live in September, and the app went on
    //      showing an agent the thing they had asked it to destroy;
    //    · and the confirmation was window.confirm(), an untranslated system
    //      box that cannot say which link it is about to kill.
    //
    //  All three are what this section pins.
    const ap = await openPage("agent@example.com");
    await sleep(900);
    await ap.page.evaluate(() => {
      // If anything still reaches for the system dialog, this counts it. It
      // must stay at zero: a confirmation that cannot be translated and cannot
      // name its subject has no business on a screen that is careful about
      // both.
      window.__CONFIRMS = 0;
      window.confirm = () => { window.__CONFIRMS++; return true; };
      document.getElementById("pmModalBack").classList.remove("is-on");
      document.getElementById("pmInviteBtn").click();
    });
    await sleep(300);

    // Step 1 asks for a note and, optionally, the number to send it to. The
    // number is the whole reason step 2 can hand the link over rather than
    // print it: without it "send this to somebody" is a text box and a shrug.
    ok(await ap.page.$("#pmInvLabel") !== null && await ap.page.$("#pmInvPhone") !== null,
       "step 1 asks who it is for, and where to send it");

    await ap.page.evaluate(() => {
      document.getElementById("pmInvLabel").value = "the couple from Kariakoo";
      document.getElementById("pmInvPhone").value = "0712 345 678";
      document.getElementById("pmInvGo").click();
    });
    await sleep(900);

    // Step 2. Five ways out, and the two that matter most are aimed at the
    // number that was typed rather than at a chooser.
    const send = await ap.page.evaluate(() => {
      const g = (id) => document.getElementById(id);
      return {
        link: g("pmInvLink") ? g("pmInvLink").value : "",
        wa: g("pmInvWa") ? g("pmInvWa").getAttribute("href") : "",
        sms: g("pmInvSms") ? g("pmInvSms").getAttribute("href") : "",
        copy: !!g("pmInvCopy"),
        qrBtn: !!g("pmInvQrGo"),
        step: (document.querySelector(".pm-steps-n") || {}).textContent || "",
      };
    });
    ok(/[?&]i=/.test(send.link), "a link is produced, carrying the token", send.link.slice(0, 60));
    // 0712 345 678 is how a number is written here; 255712345678 is how wa.me
    // has to be given it. A WhatsApp button that used what was typed opens an
    // empty chooser, which looks like the feature working.
    ok(/^https:\/\/wa\.me\/255712345678\?text=/.test(send.wa),
       "WhatsApp opens at that person, with the message ready", send.wa.slice(0, 60));
    ok(/^sms:\+255712345678[?&]body=/.test(send.sms),
       "and so does the message app", send.sms.slice(0, 60));
    ok(send.wa.includes(encodeURIComponent(send.link)),
       "both carry the link itself, not a description of it");
    ok(send.copy && send.qrBtn,
       "with the clipboard and a scannable code beside them, for the phone that has neither app");
    ok(/2/.test(send.step), "and it says which step this is", send.step);

    // The code is the only hand-off that involves nobody at all: the link goes
    // from this screen into that camera, touching no carrier and no messaging
    // company. For a bearer credential handed over in person that is the right
    // thing to offer, so it has to actually draw.
    await ap.page.evaluate(() => document.getElementById("pmInvQrGo").click());
    await sleep(400);
    ok(await ap.page.$("#pmInvQr svg") !== null,
       "the code draws, so a link can be handed over with nothing in the middle");

    // Back to the list, and make a second link. This is what makes the
    // listener question real rather than theoretical: the first render happens
    // while the list is still empty and returns before binding anything, so
    // one link can never reveal a handler bound per redraw. Two can.
    await ap.page.evaluate(() => document.getElementById("pmInvDone").click());
    await sleep(700);
    // Named too. Both rows carry a note, so "which link am I about to kill" is
    // a question the confirmation can actually be checked on: with one of them
    // blank, a confirmation naming the wrong row would still read as passing.
    await ap.page.evaluate(() => {
      document.getElementById("pmInvLabel").value = "Mr Mushi, plot 44";
      document.getElementById("pmInvGo").click();
    });
    await sleep(700);
    await ap.page.evaluate(() => document.getElementById("pmInvDone").click());
    await sleep(700);

    const listed = await ap.page.evaluate(() => ({
      rows: document.querySelectorAll("#pmInvList .pm-inv-row").length,
      revoke: document.querySelectorAll("#pmInvList [data-revoke]").length,
      forget: document.querySelectorAll("#pmInvList [data-forget]").length,
      clear: !!document.querySelector("#pmInvList [data-inv-clear]"),
    }));
    ok(listed.rows === 2, "both links are listed", JSON.stringify(listed));
    ok(listed.revoke === 2, "each with a way to withdraw it");
    ok(listed.forget === 0 && !listed.clear,
       "and nothing offering to remove a link that is still live, because it would still be live",
       JSON.stringify(listed));

    // Withdrawing asks IN the dialog, naming the link, and never through the
    // system box.
    await ap.page.evaluate(() => document.querySelector("#pmInvList [data-revoke]").click());
    await sleep(300);
    const asked = await ap.page.evaluate(() => {
      const strip = document.querySelector(".pm-inv-ask");
      return { there: !!strip, text: strip ? strip.textContent : "",
               confirms: window.__CONFIRMS,
               revokes: (window.__PM_SENT || []).filter((c) => c.name === "pm_invite_revoke").length };
    });
    ok(asked.there, "withdrawing asks first");
    // Newest first, so the first Withdraw belongs to the SECOND link made.
    // Naming the wrong one would be worse than naming none.
    ok(/Mr Mushi/.test(asked.text) && !/Kariakoo/.test(asked.text),
       "naming the link it is about, which a system dialog cannot do", asked.text.slice(0, 90));
    ok(asked.confirms === 0, "and never through window.confirm, which cannot be translated");
    ok(asked.revokes === 0, "nothing is withdrawn until the question is answered");

    await ap.page.evaluate(() => document.querySelector('.pm-inv-ask [data-ask="go"]').click());
    await sleep(900);
    const gone = await ap.page.evaluate(() => ({
      calls: (window.__PM_SENT || []).filter((c) => c.name === "pm_invite_revoke").length,
      confirms: window.__CONFIRMS,
      live: document.querySelectorAll("#pmInvList .pm-inv-row.is-live").length,
      forget: document.querySelectorAll("#pmInvList [data-forget]").length,
      clear: !!document.querySelector("#pmInvList [data-inv-clear]"),
      finished: (document.querySelector(".pm-inv-done") || {}).textContent || "",
    }));
    // ONE tap, ONE revoke. #pmInvList outlives its own rows, so a handler
    // bound per redraw accumulates: the modal renders the list on open and
    // again after every link, and the next tap would then fire several
    // revokes, all but the first failing on a hash that is already gone, which
    // paints an error over a withdrawal that worked.
    ok(gone.calls === 1,
       "exactly one revoke for one tap, however many times the list has been redrawn",
       "revoke calls: " + gone.calls);
    ok(gone.confirms === 0, "and still nothing through the system dialog");
    ok(gone.live === 1, "the withdrawn link leaves the live list", "live rows: " + gone.live);
    // It does NOT vanish. The row is what tells a customer opening that link
    // that it was withdrawn rather than mistyped, so it moves rather than
    // disappearing, and removing it is the separate act underneath.
    ok(/Mr Mushi/.test(gone.finished),
       "and moves to Finished rather than vanishing, so the reason survives for whoever opens it",
       gone.finished.slice(0, 90));
    ok(gone.forget === 1 && gone.clear,
       "where it can now be removed, one at a time or all at once", JSON.stringify(gone));

    // Removing a dead one is not confirmed: nothing can go wrong, and a
    // confirmation for an act with no consequence trains people to tap through
    // the ones that have.
    await ap.page.evaluate(() => document.querySelector("#pmInvList [data-forget]").click());
    await sleep(900);
    const cleared = await ap.page.evaluate(() => ({
      forgets: (window.__PM_SENT || []).filter((c) => c.name === "pm_invite_forget").length,
      rows: document.querySelectorAll("#pmInvList .pm-inv-row").length,
      finished: !!document.querySelector(".pm-inv-done"),
      confirms: window.__CONFIRMS,
    }));
    ok(cleared.forgets === 1, "removing a finished link calls pm_invite_forget once",
       JSON.stringify(cleared));
    ok(cleared.rows === 1 && !cleared.finished,
       "and it is gone from the list, leaving only the live one", JSON.stringify(cleared));
    ok(cleared.confirms === 0, "with no confirmation, because nothing can go wrong");

    ok(ap.errs.length === 0, "no page errors through any of it", ap.errs.slice(0, 3).join("\n        "));
    await ap.page.close();
  }

  section("8l. An announcement goes to the people on screen, and only them");
  {
    // An announcement cannot be taken back and cannot be edited. It used to
    // defend against that with a two-step preview and an invalidate() on every
    // select; the basket removes the class of bug instead, because what is on
    // screen IS the array that gets sealed. So the assertion changed from "the
    // preview was not re-asked" to the stronger "these exact ids and no
    // others".
    const ap = await openPage("pawa4761@gmail.com");
    await sleep(900);
    await ap.page.evaluate(async () => {
      for (const id of ["agent_juma", "agent_neema"]) {
        const kp = await window.PMCrypto.generateIdentity();
        window.__PM_DB.keys[id].public_key = kp.publicKey;
      }
      document.getElementById("pmModalBack").classList.remove("is-on");
      document.getElementById("pmBroadcastBtn").click();
    });
    await sleep(500);

    ok(await ap.page.$("#pmPkCat") !== null,
       "the audience can still be narrowed by what people deal in, not only by where they are");
    ok(await ap.page.evaluate(() => document.getElementById("pmCastGo").disabled),
       "and Send is off until somebody is in the basket");

    // Pick exactly one person, by hand. This is the thing the old announce
    // dialog could not do at all: it had no per-person control of any kind.
    const picked = await ap.page.evaluate(async () => {
      document.querySelector('[data-src="all"]').click();
      await new Promise((r) => setTimeout(r, 800));
      const box = document.querySelector('#pmPkList .pm-pick input:not(:disabled)');
      box.checked = true;
      box.dispatchEvent(new Event("change", { bubbles: true }));
      return box.value;
    });
    await sleep(400);
    const shown = await ap.page.evaluate(() => ({
      chips: document.querySelectorAll("#pmPkBasket .pm-chip").length,
      canSend: !document.getElementById("pmCastGo").disabled,
      go: document.getElementById("pmCastGo").textContent,
    }));
    ok(shown.chips === 1, "one person chosen shows one chip", JSON.stringify(shown));
    ok(shown.canSend, "and only then does Send mean anything");
    ok(/\d/.test(shown.go), "with the number on the button itself", shown.go);

    const secretCast = "Bei mpya kuanzia Jumatatu.";
    await ap.page.evaluate((txt) => {
      document.getElementById("pmCastBody").value = txt;
      document.getElementById("pmCastGo").click();
    }, secretCast);
    await sleep(1800);
    const sent = await ap.page.evaluate(() => {
      const call = (window.__PM_SENT || []).filter((c) => c.name === "pm_broadcast").pop();
      return {
        n: (window.__PM_SENT || []).filter((c) => c.name === "pm_broadcast").length,
        ids: call ? (call.args.p_keys || []).map((k) => k.user_id) : null,
        // A non-admin has no business calling the admin's scope query, and
        // neither does anybody else now: there is no scope to resolve.
        asked: (window.__PM_SENT || []).filter((c) => c.name === "pm_recipients").length,
        msg: document.getElementById("pmCastMsg").textContent,
      };
    });
    // PMStore.me() is async, so it cannot be read inline above. The identity
    // this device published is the one on the key row it wrote.
    sent.me = await ap.page.evaluate(async () => (await window.PMStore.me()).userId);
    ok(sent.n === 1, "the announcement goes once", JSON.stringify(sent));
    // TWO WRAPS FOR ONE RECIPIENT, AND THE SECOND ONE IS THE POINT.
    //
    // This used to assert exactly one, which is what an announcement "sealed to
    // the basket" looks like from the outside and is a bug from the inside.
    // There is no separate "sent" store in P-Message: your copy of a message is
    // just another wrap, which is why PMCrypto.seal() says in its own header
    // that the sender must be in the list. Every other send path gets that free
    // from pm_thread_keys(); broadcast built its list from the audience, and
    // nobody is in an audience they are announcing to. So pm_broadcast wrote
    // the sender in as thread OWNER with no key row of their own, and their own
    // announcement came back to them as "encrypted for another device".
    //
    // Do not "fix" this back to a length of one.
    ok(sent.ids && sent.ids.indexOf(picked) >= 0,
       "sealed to the person in the basket", JSON.stringify(sent.ids));
    ok(sent.ids && sent.ids.indexOf(sent.me) >= 0,
       "and to the sender, so they can read their own announcement back",
       JSON.stringify(sent));
    ok(sent.ids && sent.ids.length === 2,
       "and to nobody else at all", JSON.stringify(sent.ids));
    ok(sent.asked === 0,
       "and no scope was resolved at all: there is no second question that could give a different answer",
       String(sent.asked));
    ok(/sent to \d+/i.test(sent.msg), "reporting how many it reached", sent.msg);
    // The assertion this whole suite exists for, applied to the new path.
    ok(!ap.bodies.some((b) => b.indexOf(secretCast) >= 0),
       "and the words of the announcement are in no request body");
    await ap.page.close();
  }

  section("8n. An advert reaches people you deal with, and says so about the rest");
  {
    // The fence that replaced "Admins only". An ordinary account may announce
    // now, and the limit moved from WHO is sending to WHO they may reach:
    // somebody you have never written to is drawn, greyed, and told why,
    // rather than hidden. A row that vanishes teaches nothing.
    const ap = await openPage("ordinary@example.com");
    await sleep(900);
    await ap.page.evaluate(async () => {
      for (const id of ["agent_juma", "plain_amina"]) {
        const kp = await window.PMCrypto.generateIdentity();
        window.__PM_DB.keys[id].public_key = kp.publicKey;
      }
      document.getElementById("pmBroadcastBtn").click();
    });
    await sleep(400);
    await ap.page.evaluate(() => document.querySelector('[data-src="all"]').click());
    await sleep(900);

    const cold = await ap.page.evaluate(() => ({
      rows: document.querySelectorAll("#pmPkList .pm-pick").length,
      off: document.querySelectorAll("#pmPkList .pm-pick.is-off").length,
      enabled: document.querySelectorAll("#pmPkList .pm-pick input:not(:disabled)").length,
      why: (document.querySelector("#pmPkList .pm-pk-why") || {}).textContent || "",
      canSend: !document.getElementById("pmCastGo").disabled,
    }));
    ok(cold.rows >= 2, "the directory is still shown in full", JSON.stringify(cold.rows));
    ok(cold.off === cold.rows && cold.enabled === 0,
       "but with nobody this account has dealt with, not one of them can be chosen",
       JSON.stringify(cold));
    ok(/written to each other/i.test(cold.why),
       "and each row says why, as a fact about the relationship rather than about them", cold.why);
    ok(!cold.canSend, "so there is nothing to send");

    // Now make one of them a real contact: a direct thread both people have
    // written in. That is the whole definition, and a room would not do it.
    await ap.page.evaluate(() => {
      document.getElementById("pmModalBack").classList.remove("is-on");
      const db = window.__PM_DB;
      db.threads["known"] = { kind: "direct", members: ["user_self", "agent_juma"] };
      db.messages.push({ id: "m1", thread_id: "known", sender_id: "user_self", iv: "x", ciphertext: "y" });
      db.messages.push({ id: "m2", thread_id: "known", sender_id: "agent_juma", iv: "x", ciphertext: "y" });
      document.getElementById("pmBroadcastBtn").click();
    });
    await sleep(400);
    await ap.page.evaluate(() => document.querySelector('[data-src="all"]').click());
    await sleep(900);
    const warm = await ap.page.evaluate(() => ({
      enabled: Array.from(document.querySelectorAll("#pmPkList .pm-pick input:not(:disabled)"))
        .map((i) => i.value),
    }));
    ok(warm.enabled.length === 1 && warm.enabled[0] === "agent_juma",
       "once you have both written, that one person can be announced to, and still nobody else",
       JSON.stringify(warm.enabled));

    // And the default source is the contacts, so the common case needs no
    // searching at all.
    await ap.page.evaluate(() => {
      document.getElementById("pmModalBack").classList.remove("is-on");
      document.getElementById("pmBroadcastBtn").click();
    });
    await sleep(1000);
    const mine = await ap.page.evaluate(() =>
      Array.from(document.querySelectorAll("#pmPkList .pm-pick input")).map((i) => i.value));
    ok(mine.length === 1 && mine[0] === "agent_juma",
       "and People you deal with is where the picker opens", JSON.stringify(mine));
    ok(ap.errs.length === 0, "no page errors", ap.errs.slice(0, 3).join("\n        "));
    await ap.page.close();
  }

  section("8p. Keeping the people, so next week is one tap");
  {
    // The basket dies with the dialog. Without lists, a room of the same
    // eleven people next week is eleven taps again, which is the difference
    // between a feature somebody can use and one they will.
    const ap = await openPage("pawa4761@gmail.com");
    await sleep(900);
    await ap.page.evaluate(async () => {
      for (const id of ["agent_juma", "agent_neema"]) {
        const kp = await window.PMCrypto.generateIdentity();
        window.__PM_DB.keys[id].public_key = kp.publicKey;
      }
      document.getElementById("pmRoomsBtn").click();
    });
    await sleep(400);
    await ap.page.evaluate(() => document.querySelector('[data-src="all"]').click());
    await sleep(900);
    await ap.page.evaluate(() => document.querySelector('#pmPkHead [data-all="1"]').click());
    await sleep(300);

    // Naming it is an inline field, not window.prompt: a browser dialog
    // carries chrome nobody here can translate.
    await ap.page.evaluate(() => document.querySelector("[data-save]").click());
    await sleep(200);
    ok(await ap.page.$eval("#pmPkSaveRow", (n) => !n.hidden), "the basket can be named and kept");
    await ap.page.evaluate(() => {
      document.getElementById("pmPkName").value = "Mwanza regulars";
      document.getElementById("pmPkSaveGo").click();
    });
    await sleep(700);
    const saved = await ap.page.evaluate(() =>
      (window.__PM_SENT || []).filter((c) => c.name === "pm_list_create").pop());
    ok(!!saved && saved.args.p_name === "Mwanza regulars" && saved.args.p_members.length >= 2,
       "and the ids that were on screen are what gets kept",
       JSON.stringify(saved && saved.args));

    // Reopen from the list. This is the whole point: the second room is one
    // tab and one chip, not a re-pick.
    await ap.page.evaluate(() => {
      document.getElementById("pmModalBack").classList.remove("is-on");
      document.getElementById("pmRoomsBtn").click();
    });
    await sleep(400);
    await ap.page.evaluate(() => document.querySelector('[data-src="list"]').click());
    await sleep(900);
    const fromList = await ap.page.evaluate(() => ({
      chips: Array.from(document.querySelectorAll("#pmPkLists .pm-chip")).map((c) => c.textContent.trim()),
      rows: document.querySelectorAll("#pmPkList .pm-pick").length,
    }));
    ok(fromList.chips.length === 1 && /Mwanza regulars/.test(fromList.chips[0]),
       "the list is there, with how many people are in it", JSON.stringify(fromList.chips));
    ok(fromList.rows >= 2, "and choosing it brings those people back", JSON.stringify(fromList.rows));
    ok(ap.errs.length === 0, "no page errors", ap.errs.slice(0, 3).join("\n        "));
    await ap.page.close();
  }

  section("8o. Blocking, and saying what it does not do");
  {
    const ap = await openPage("ordinary@example.com");
    await sleep(900);
    await ap.page.evaluate(async () => {
      const kp = await window.PMCrypto.generateIdentity();
      window.__PM_DB.keys["agent_juma"].public_key = kp.publicKey;
      window.__PM_DB.threads["known"] = { kind: "direct", members: ["user_self", "agent_juma"] };
      // Nudge the live subscription rather than reloading: a reload would run
      // the stub again and take the thread with it.
      if (window.__PM_FIRE_INSERT) window.__PM_FIRE_INSERT();
    });
    await sleep(900);
    await ap.page.evaluate(() => document.getElementById("segChats").click());
    await sleep(600);
    // A one to one conversation between two accounts had NO menu at all until
    // now: there was nothing on offer, because neither side may delete the
    // other's copy. There is something on offer now.
    ok(await ap.page.$('[data-chat-menu][data-menu-kind="chat"]') !== null,
       "an ordinary conversation carries a menu now, because there is finally something to do with it");
    await ap.page.evaluate(() =>
      document.querySelector('[data-chat-menu][data-menu-kind="chat"]').click());
    await sleep(400);
    ok(await ap.page.$("#pmCmBlock") !== null, "and the thing on offer is Block");
    ok(await ap.page.$("#pmCmDelChat") === null,
       "and still not Delete, because the database refuses to let one side erase the other's copy");

    await ap.page.evaluate(() => document.getElementById("pmCmBlock").click());
    await sleep(400);
    const dialog = await ap.page.evaluate(() =>
      document.getElementById("pmModal").textContent);
    ok(/does not delete this conversation/i.test(dialog),
       "the confirm says what a block does NOT do, not only what it does");
    // The promise was deliberately softened: "They are not told" became
    // "Nothing tells them, but they will find out if they try to write." Both
    // halves matter. pm_can_speak refuses the send, so a block that promised
    // silence would be promising something the database does not deliver, and
    // the alternative — accepting the message and dropping it — is the feature
    // lying about delivery. So the assertion is on the CLAIM, both halves of
    // it, rather than on one form of words.
    ok(/nothing tells them|not told/i.test(dialog),
       "including that nothing notifies the other person", dialog.slice(0, 200));
    ok(/find out if they try/i.test(dialog),
       "and that they will find out if they try to write, which is what actually happens",
       dialog.slice(0, 200));

    await ap.page.evaluate(() => document.getElementById("pmBlYes").click());
    await sleep(900);
    const blocked = await ap.page.evaluate(() =>
      (window.__PM_SENT || []).filter((c) => c.name === "pm_block").pop());
    ok(!!blocked && blocked.args.p_user === "agent_juma",
       "and confirming blocks that person", JSON.stringify(blocked && blocked.args));

    // The point of the whole thing: they drop out of the picker.
    await ap.page.evaluate(() => {
      document.getElementById("pmModalBack").classList.remove("is-on");
      document.getElementById("pmRoomsBtn").click();
    });
    await sleep(400);
    await ap.page.evaluate(() => document.querySelector('[data-src="all"]').click());
    await sleep(900);
    const after = await ap.page.evaluate(() => ({
      enabled: Array.from(document.querySelectorAll("#pmPkList .pm-pick input:not(:disabled)"))
        .map((i) => i.value),
    }));
    ok(after.enabled.indexOf("agent_juma") < 0,
       "a blocked person cannot be gathered into a room either", JSON.stringify(after.enabled));

    // And the conversation you blocked FROM goes quiet. pm_can_speak() had
    // existed since blocking shipped with nothing calling it, so the composer
    // stayed live and the send threw a raw server string at whoever pressed
    // it: the refusal arriving after the sentence was written instead of
    // before. The placeholder must not say WHICH of you blocked the other --
    // "they blocked you" is the one thing a block exists in order not to say.
    await ap.page.evaluate(() => {
      document.getElementById("pmModalBack").classList.remove("is-on");
      document.getElementById("segChats").click();
    });
    await sleep(500);
    await ap.page.evaluate(() => {
      var row = document.querySelector('.pm-row[data-thread="known"]');
      if (row) row.click();
    });
    await sleep(900);
    const hush = await ap.page.evaluate(() => ({
      off: document.getElementById("pmInput").disabled,
      ph: document.getElementById("pmInput").placeholder,
    }));
    ok(hush.off, "the composer in that conversation is switched off", JSON.stringify(hush));
    ok(!/block/i.test(hush.ph),
       "and the placeholder does not say who blocked whom", hush.ph);
    ok(ap.errs.length === 0, "no page errors", ap.errs.slice(0, 3).join("\n        "));
    await ap.page.close();
  }

  // ===========================================================================
  //  The report that provoked this: "there is something like people you have
  //  blocked as if there is no any option in the app to block or unblock".
  //
  //  Both halves were true. Blocking WORKED -- the SQL, the store call, the
  //  confirm dialog and the unblock list were all built and wired -- but
  //  PMBlock.ask() had exactly ONE call site in the whole app: the dot menu on
  //  a conversation row, which rowMenuKind() only yields for a direct thread
  //  with a non-guest account. On the production data that row type does not
  //  exist for anybody, so Profile showed "People you blocked" over a list
  //  nothing in the app could add to.
  //
  //  So the assertions here are about DOORS, not about blocking. A feature
  //  reachable from one place that most accounts never see is not reachable.
  // ===========================================================================
  section("8q. There is a way to block somebody you have never spoken to");
  {
    const ap = await openPage("ordinary@example.com");
    await sleep(900);
    await ap.page.evaluate(() => document.getElementById("segPeople").click());
    await sleep(1200);

    const dots = await ap.page.evaluate(() =>
      document.querySelectorAll("#pmPeople [data-person-menu]").length);
    ok(dots > 0, "every row in the agent list carries a menu", String(dots) + " found");

    // The row's own button opens a conversation. The dots must NOT: they are
    // a sibling of it inside the actions strip, and if the row handler caught
    // them first this door would silently be "message them" instead.
    await ap.page.evaluate(() =>
      document.querySelector("#pmPeople [data-person-menu]").click());
    await sleep(500);
    ok(await ap.page.$("#pmPmBlock") !== null,
       "and it offers Block, without needing a conversation first");
    ok(await ap.page.$("#pmConv.is-on") === null,
       "and it did not open the conversation instead");

    await ap.page.evaluate(() => document.getElementById("pmPmBlock").click());
    await sleep(400);
    ok(await ap.page.$("#pmBlYes") !== null,
       "which hands straight to the one confirm dialog, not a second copy of it");
    ok(ap.errs.length === 0, "no page errors", ap.errs.slice(0, 3).join("\n        "));
    await ap.page.close();
  }

  section("8m. The thread list stays live");
  {
    // Until this existed the only live delivery was per-open-conversation, so
    // a reply arriving while you looked at the list — or a whole new
    // conversation somebody started with you — showed up only on reload. Two
    // people cannot talk to each other if neither is told the other answered.
    const ap = await openPage("watcher@example.com");
    await sleep(900);
    const watching = await ap.page.evaluate(() => ({
      chans: (window.__PM_CHANNELS || []).slice(),
    }));
    ok(watching.chans.some((c) => /pm_inbox_/.test(c)),
       "the page subscribes to the whole inbox, not only to an open conversation",
       JSON.stringify(watching.chans));

    const before = await ap.page.evaluate(() =>
      (window.__PM_SENT || []).filter((c) => c.name === "pm_inbox").length);
    await ap.page.evaluate(() => window.__PM_FIRE_INSERT && window.__PM_FIRE_INSERT());
    await sleep(600);
    const afterN = await ap.page.evaluate(() =>
      (window.__PM_SENT || []).filter((c) => c.name === "pm_inbox").length);
    ok(afterN > before,
       "and a message landing anywhere refreshes it", before + " -> " + afterN);
    ok(ap.errs.length === 0, "no page errors while watching", ap.errs.slice(0, 3).join("\n        "));
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
  // Read from inside the dialog rather than off the chip. The header used to
  // print the whole number and it wrapped mid-digit-group; a guest's number is
  // as real as anybody's, so it is checked where it is actually shown.
  await guest.page.evaluate(() => document.getElementById("pmFpBtn").click());
  await sleep(400);
  const guestFp = await guest.page.evaluate(() => {
    const g = document.querySelector("#pmModal .pm-big-fp");
    return g ? g.textContent.trim() : "";
  });
  ok(/^\d{5}( \d{5}){5}$/.test(guestFp), "and their own safety number", guestFp);
  await guest.page.evaluate(() => {
    const b = document.getElementById("pmFpOk");
    if (b) b.click();
  });
  await sleep(200);

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

  section("10. Arriving from jobs.html — p-message.html?to=<user id>");
  // The seam between the two pages. jobs.html knows WHO; it does not know
  // their key, their name as P-Message stores it, or where they work, and it
  // must not be the thing that decides any of those.
  {
    const dl = await openPage("worker@example.com", { path: "p-message.html?to=agent_juma", peerKey: PEER_KEY });
    await sleep(1800);

    ok(await dl.page.$eval("#pmConv", (n) => n.classList.contains("is-on")),
       "the conversation opens straight away, without a search");
    const dlName = await dl.page.$eval("#pmConvName", (n) => n.textContent);
    ok(/Juma/.test(dlName), "with the right person", dlName);

    // The name came from pm_peer. The URL never carried one, and this is what
    // keeps it that way: a link able to name its own peer would let a doctored
    // URL put a borrowed name on the one screen that exists to say who this is.
    // The fixture's id (`agent_juma`) deliberately shares a word with the name
    // it is stored under (`Juma Mwanga`), so asking whether the URL contains
    // "Juma" would answer the wrong question. What matters is that there is
    // exactly ONE parameter, and that the part of the name only pm_peer knows
    // is on the header and nowhere in the link.
    const dlUrl = await dl.page.evaluate(() => location.search);
    const dlKeys = await dl.page.evaluate(() => [...new URLSearchParams(location.search).keys()]);
    ok(dlKeys.length === 1 && dlKeys[0] === "to",
       "and the URL carried one parameter, the id", JSON.stringify(dlKeys));
    ok(/Mwanga/.test(dlName) && !/Mwanga/.test(dlUrl),
       "with the name on the header coming from pm_peer, not from the link",
       dlUrl + "  header=" + dlName);

    const started = await dl.page.evaluate(() =>
      window.__PM_SENT.filter((c) => c.name === "pm_start_direct").map((c) => c.args.p_other));
    ok(started.length === 1 && started[0] === "agent_juma",
       "one thread started, with the person the link named", JSON.stringify(started));
    ok(await dl.page.$eval("#pmVerify", (n) => !n.hidden),
       "and verification is offered, because this is a direct thread");
    ok(dl.errs.length === 0, "no page errors on the deep link", dl.errs.slice(0, 3).join(" | "));
    await dl.page.close();
  }
  {
    // A link to somebody who has never opened P-Message. No key means nothing
    // to encrypt to, so the page says so rather than opening an empty thread
    // that could never carry a message.
    const dead = await openPage("worker@example.com", { path: "p-message.html?to=agent_blank" });
    await sleep(1800);
    ok(!(await dead.page.$eval("#pmConv", (n) => n.classList.contains("is-on"))),
       "a link to someone with no key opens no conversation");
    ok(await dead.page.$eval("#pmModalBack", (n) => n.classList.contains("is-on")),
       "it says why instead");
    const said = await dead.page.$eval("#pmModal", (n) => n.textContent);
    ok(/not opened P-Message/i.test(said), "in the same words the directory uses", said.slice(0, 90));
    const startedDead = await dead.page.evaluate(() =>
      window.__PM_SENT.filter((c) => c.name === "pm_start_direct"));
    ok(startedDead.length === 0,
       "and no thread was created for a chat that cannot happen", String(startedDead.length));
    ok(dead.errs.length === 0, "no page errors", dead.errs.slice(0, 3).join(" | "));
    await dead.page.close();
  }
  {
    // A stale or hand-typed id must not break the page. The inbox is a screen
    // that works; an error about a user id nobody has seen is not.
    const junk = await openPage("worker@example.com", { path: "p-message.html?to=nobody_at_all" });
    await sleep(1800);
    ok(!(await junk.page.$eval("#pmConv", (n) => n.classList.contains("is-on"))),
       "an unknown id opens no conversation");
    const junkPage = await junk.page.evaluate(() => ({
      segs: document.querySelectorAll(".pm-segs .pm-seg").length,
      chatsOn: !!document.querySelector("#paneChats.is-on"),
      modal: !!document.querySelector("#pmModalBack.is-on"),
    }));
    ok(junkPage.segs === 3 && junkPage.chatsOn && !junkPage.modal,
       "and the page is still the page, not an error about an id nobody saw",
       JSON.stringify(junkPage));
    ok(junk.errs.length === 0, "with no page errors", junk.errs.slice(0, 3).join(" | "));
    await junk.page.close();
  }

  section("11. Is anyone there? — presence on the agent list");
  // The question the list could not answer. A directory of forty names in
  // which most have not opened the app since March is a queue with no server,
  // and the only way to find that out was to write to each of them and wait.
  {
    const dp = await openPage("someone@example.com", { peerKey: PEER_KEY });
    await sleep(900);
    await dp.page.evaluate(() => document.getElementById("segPeople").click());
    await sleep(700);

    const rows = await dp.page.$$eval("#pmPeople .pm-row", (ns) => ns.map((r) => ({
      id: r.dataset.person,
      seen: (r.querySelector(".pm-seen") || {}).textContent || null,
      state: (r.querySelector(".pm-seen") || { className: "" }).className,
    })));
    const juma = rows.find((r) => r.id === "agent_juma");
    const neema = rows.find((r) => r.id === "agent_neema");
    const blank = rows.find((r) => r.id === "agent_blank");

    ok(!!juma && /Online/i.test(juma.seen || ""), "somebody beating right now reads as online", JSON.stringify(juma));
    ok(!!juma && /is-online/.test(juma.state), "and gets the live dot, not a grey one");
    // Neema has no key, so she is unreachable and the row draws no presence
    // at all — a last-seen for somebody who cannot be written to is a fact
    // with nothing to do.
    ok(!!neema && !neema.seen, "an unreachable person gets no presence line, because there is nothing to say to them",
       JSON.stringify(neema));
    ok(!!blank && !blank.seen,
       "and somebody never seen gets NOTHING rather than 'last seen never' — that would be a claim about them",
       JSON.stringify(blank));

    // The beat itself.
    const beats = await dp.page.evaluate(() =>
      (window.__PM_SENT || []).filter((c) => c.name === "pm_touch_seen").length);
    ok(beats >= 1, "the page says it is here, once, on open", String(beats));
    const win = await dp.page.evaluate(() =>
      (window.__PM_SENT || []).some((c) => c.name === "pm_online_window"));
    ok(win, "and takes the length of 'online' from the database rather than guessing it");

    ok(dp.errs.length === 0, "no page errors", dp.errs.slice(0, 3).join(" | "));
    await dp.page.close();
  }

  section("12. What kind of work, and somewhere to go and look");
  // "4 services" is the count of a thing whose identity was thrown away one
  // join earlier: a plumber, a hairdresser and a night guard all read the same.
  {
    const dp = await openPage("someone@example.com", { peerKey: PEER_KEY });
    await sleep(900);
    await dp.page.evaluate(() => document.getElementById("segPeople").click());
    await sleep(700);

    const rows = await dp.page.$$eval("#pmPeople .pm-person-wrap", (ns) => ns.map((w) => {
      const r = w.querySelector(".pm-row");
      const a = w.querySelector(".pm-open");
      return {
        id: r.dataset.person,
        kinds: Array.from(w.querySelectorAll(".pm-kind")).map((k) => k.textContent.trim()),
        href: a ? a.getAttribute("href") : null,
      };
    }));
    const juma = rows.find((r) => r.id === "agent_juma");
    const blank = rows.find((r) => r.id === "agent_blank");

    ok(!!juma && juma.kinds.length > 0, "the row says what kind of work, in words", JSON.stringify(juma));
    ok(!!juma && juma.kinds.some((k) => /Apartment/i.test(k)),
       "labelled, not printed as the stored slug", JSON.stringify(juma && juma.kinds));
    ok(!!blank && blank.kinds.length === 0,
       "and somebody with nothing listed claims no kinds at all");

    ok(!!juma && juma.href === "agent.html?u=agent_juma",
       "a link to their storefront, carrying only the id", JSON.stringify(juma && juma.href));
    ok(!!blank && !blank.href,
       "and no link for somebody whose page would be empty");

    // The link must not swallow the row's own tap.
    await dp.page.evaluate(() => document.querySelector('[data-person="agent_juma"]').click());
    await sleep(900);
    ok(await dp.page.$eval("#pmConv", (n) => n.classList.contains("is-on")),
       "tapping the row still opens the conversation");

    ok(dp.errs.length === 0, "no page errors", dp.errs.slice(0, 3).join(" | "));
    await dp.page.close();
  }

  section("13. Answering one message");
  // In a room with thirty people "yes, 300,000" is an answer to a question
  // nine messages back and unreadable without it.
  {
    const dp = await openPage("someone@example.com", { peerKey: PEER_KEY });
    await sleep(900);
    // Every page in this run shares one localStorage, and section 8e
    // deliberately substituted this agent's key. Left in place, that pin is a
    // real change: the alarm fires, the composer is BLOCKED, and nothing here
    // could send anything — a section that tested the reply feature would
    // instead be testing the trust fence, silently.
    await dp.page.evaluate(() => localStorage.removeItem("pm-trust-v1"));
    await dp.page.reload({ waitUntil: "domcontentloaded" });
    await sleep(1700);
    await dp.page.evaluate(() => document.getElementById("segPeople").click());
    await sleep(600);
    await dp.page.evaluate(() => document.querySelector('[data-person="agent_juma"]').click());
    await sleep(900);

    const FIRST = "Nyumba ya vyumba viwili Nyamagana iko wapi?";
    await dp.page.evaluate((txt) => {
      const i = document.getElementById("pmInput");
      i.value = txt;
      document.getElementById("pmComposeForm").dispatchEvent(new Event("submit"));
    }, FIRST);
    await sleep(1200);

    const bubbles = await dp.page.$$eval("#pmLog .pm-msg", (ns) => ns.map((n) => ({
      id: n.dataset.msg, hasReply: !!n.querySelector("[data-reply]"),
    })));
    ok(bubbles.length >= 1 && bubbles[0].hasReply,
       "every message offers a way to answer it", JSON.stringify(bubbles));

    await dp.page.evaluate(() => document.querySelector("#pmLog [data-reply]").click());
    await sleep(300);
    const bar = await dp.page.evaluate(() => {
      const b = document.getElementById("pmReplyBar");
      return { hidden: b.hidden, text: b.textContent.trim() };
    });
    ok(!bar.hidden, "choosing one raises a strip above the composer");
    ok(/Replying to/i.test(bar.text) && bar.text.indexOf(FIRST.slice(0, 20)) >= 0,
       "which says who and what, so the answer cannot land on a message nobody remembers picking",
       bar.text);

    const REPLY = "Iko Mkuyuni, karibu na soko.";
    await dp.page.evaluate((txt) => {
      const i = document.getElementById("pmInput");
      i.value = txt;
      document.getElementById("pmComposeForm").dispatchEvent(new Event("submit"));
    }, REPLY);
    await sleep(1300);

    const sends = await dp.page.evaluate(() =>
      (window.__PM_SENT || []).filter((c) => c.name === "pm_send"));
    ok(sends.length === 2, "the answer went as one ordinary message", String(sends.length));
    ok(!!sends[1] && !!sends[1].args.p_reply_to,
       "carrying the id of what it answers", JSON.stringify(sends[1] && sends[1].args.p_reply_to));
    ok(!!sends[1] && sends[1].args.p_reply_to === bubbles[0].id,
       "and it is the id of the message that was chosen");

    // THE POINT: only an id. The quoted words must never leave the tab.
    const leaked = dp.bodies.filter((b) => b.includes(FIRST) || b.includes(REPLY));
    ok(leaked.length === 0,
       "and neither message's words appear in ANY request body — the quote is never sent",
       String(leaked.length));

    const after = await dp.page.evaluate(() => document.getElementById("pmReplyBar").hidden);
    ok(after, "sending clears the strip, or a second message answers the same thing again");

    const quotes = await dp.page.$$eval("#pmLog .pm-quote", (ns) => ns.map((n) => ({
      gone: n.classList.contains("is-gone"),
      text: n.textContent.trim(),
      goto: n.dataset.goto || null,
    })));
    ok(quotes.length === 1, "the answer is drawn with the question above it", String(quotes.length));
    ok(!!quotes[0] && !quotes[0].gone && quotes[0].text.indexOf(FIRST.slice(0, 20)) >= 0,
       "quoting what the original actually said, from this device's own copy", JSON.stringify(quotes[0]));
    ok(!!quotes[0] && quotes[0].goto === bubbles[0].id,
       "and pointing back at it, so a tap can go there");

    await dp.page.evaluate(() => document.querySelector("#pmLog [data-reply]").click());
    await sleep(250);
    await dp.page.evaluate(() => document.getElementById("pmReplyX").click());
    await sleep(250);
    ok(await dp.page.evaluate(() => document.getElementById("pmReplyBar").hidden),
       "and a chosen message can be un-chosen");

    await dp.page.evaluate(() => document.querySelector("#pmLog [data-reply]").click());
    await sleep(250);
    await dp.page.evaluate(() => document.getElementById("pmBack").click());
    await sleep(400);
    ok(await dp.page.evaluate(() => document.getElementById("pmReplyBar").hidden),
       "closing the conversation drops it too — a reply belongs to the room it was chosen in");

    ok(dp.errs.length === 0, "no page errors", dp.errs.slice(0, 3).join(" | "));
    await dp.page.close();
  }

  section("13b. Two ways of reaching one person");
  // The pane answers "who can help me" and then offered exactly one way of
  // acting on the answer. Somebody who needs a canter this afternoon does not
  // want a conversation, and some of the people in this list cannot hold one:
  // they have listings and no P-Message key. The number they printed on their
  // own listing was the missing half.
  {
    const dp = await openPage("someone@example.com", { peerKey: PEER_KEY });
    await sleep(900);
    await dp.page.evaluate(() => document.getElementById("segPeople").click());
    await sleep(800);

    const cards = await dp.page.$$eval("#pmPeople .pm-person-wrap", (ns) => ns.map((w) => {
      const row = w.querySelector(".pm-row");
      const call = w.querySelector(".pm-act.is-call");
      return {
        id: row ? row.dataset.person : null,
        msg: !!w.querySelector(".pm-act.is-msg"),
        call: call ? call.getAttribute("href") : null,
        callPrimary: !!(call && call.classList.contains("is-only")),
        shop: !!w.querySelector(".pm-open"),
        // The actions must be SIBLINGS of the row button, never inside it: an
        // <a> in a <button> is markup a browser silently repairs by moving the
        // link out, and the repair is what breaks the layout.
        nested: !!(row && row.querySelector(".pm-act")),
      };
    }));
    const juma = cards.find((c) => c.id === "agent_juma");
    const neema = cards.find((c) => c.id === "agent_neema");
    const blank = cards.find((c) => c.id === "agent_blank");

    ok(!!juma && juma.msg && !!juma.call,
       "somebody reachable who also published a number offers both", JSON.stringify(juma));
    ok(!!juma && juma.call === "tel:0712345678",
       "the number dials, with the spaces somebody typed taken out", juma && juma.call);
    ok(!!neema && !neema.msg && neema.call === "tel:+255754111222",
       "somebody who never opened P-Message can still be rung, and a leading + survives",
       JSON.stringify(neema));
    ok(!!neema && neema.callPrimary,
       "and on that row the call is drawn as the primary action, because it is the only one that works");
    ok(!!juma && !juma.callPrimary,
       "while a row that can be written to keeps writing as the filled button");
    ok(!!blank && !blank.call,
       "somebody who has published no number gets no call button and no empty one", JSON.stringify(blank));
    ok(cards.every((c) => !c.nested),
       "and no action is nested inside the row's own button", JSON.stringify(cards));

    // Tapping Call must not also open a conversation: they are different
    // intentions and one of them costs a stranger a message.
    await dp.page.evaluate(() => {
      const a = document.querySelector(".pm-act.is-call");
      a.addEventListener("click", (e) => e.preventDefault(), { once: true });
      a.click();
    });
    await sleep(500);
    ok(!(await dp.page.$eval("#pmConv", (n) => n.classList.contains("is-on"))),
       "tapping Call does not also open the conversation");

    // And the Message chip does what the whole card does.
    await dp.page.evaluate(() =>
      document.querySelector('.pm-act.is-msg[data-person="agent_juma"]').click());
    await sleep(1200);
    ok(await dp.page.$eval("#pmConv", (n) => n.classList.contains("is-on")),
       "and the Message chip opens it");

    ok(dp.errs.length === 0, "no page errors", dp.errs.slice(0, 3).join(" | "));
    await dp.page.close();
  }

  section("13c. Deleting a message, and being honest about what that means");
  // The other copy is on the other phone, encrypted with a key this device has
  // never held. There is no request that takes it back. So the feature does
  // the one thing it can do, says so before the tap, and destroys nothing.
  {
    const dp = await openPage("someone@example.com", { peerKey: PEER_KEY });
    await sleep(900);
    await dp.page.evaluate(() => {
      localStorage.removeItem("pm-trust-v1");
      localStorage.removeItem("pm-hidden-v1");
    });
    await dp.page.reload({ waitUntil: "domcontentloaded" });
    await sleep(1700);
    await dp.page.evaluate(() => document.getElementById("segPeople").click());
    await sleep(600);
    await dp.page.evaluate(() => document.querySelector('[data-person="agent_juma"]').click());
    await sleep(900);

    const KEEP = "Nitakuja kesho asubuhi.";
    const DROP = "Namba yangu ya siri ni 4471.";
    for (const txt of [KEEP, DROP]) {
      await dp.page.evaluate((one) => {
        document.getElementById("pmInput").value = one;
        document.getElementById("pmComposeForm").dispatchEvent(new Event("submit"));
      }, txt);
      await sleep(1100);
    }
    ok((await dp.page.$$eval("#pmLog .pm-msg", (n) => n.length)) === 2,
       "two messages are in the log to start with");

    const storedBefore = await dp.page.evaluate(() => window.__PM_DB.messages.length);

    // Open the menu on the second one.
    await dp.page.evaluate(() => {
      const all = document.querySelectorAll("#pmLog .pm-msg [data-menu]");
      all[all.length - 1].click();
    });
    await sleep(350);
    const sheet = await dp.page.evaluate(() => document.getElementById("pmModal").textContent);
    ok(/Delete for me/i.test(sheet), "the dot menu offers a delete", sheet.slice(0, 120));
    ok(/keep their copy/i.test(sheet),
       "and states the limit on the row that offers it, not in small print afterwards",
       sheet.slice(0, 200));

    await dp.page.evaluate(() => document.getElementById("pmMmDel").click());
    await sleep(300);
    const confirm = await dp.page.evaluate(() => document.getElementById("pmModal").textContent);
    ok(/this device|this phone/i.test(confirm),
       "the confirmation says where it goes and where it does not", confirm.slice(0, 200));
    ok(/no way for this app to reach/i.test(confirm),
       "in words, rather than implying a delete-for-everyone it cannot do", confirm.slice(0, 260));
    ok(confirm.indexOf(DROP.slice(0, 18)) >= 0,
       "and quotes the message back, so nobody hides the wrong one");

    await dp.page.evaluate(() => document.getElementById("pmDelYes").click());
    await sleep(500);

    const after = await dp.page.$$eval("#pmLog .pm-msg", (ns) => ns.map((n) => n.textContent));
    ok(after.length === 1 && after[0].indexOf(KEEP) >= 0,
       "it stops being drawn, and only it", JSON.stringify(after));
    ok(await dp.page.evaluate(() => window.__PM_DB.messages.length) === storedBefore,
       "no request went to delete anything, because there is nothing this app could ask for");

    const note = await dp.page.evaluate(() => {
      const n = document.querySelector("#pmLog .pm-hidnote");
      return n ? n.textContent : null;
    });
    ok(!!note && /hidden on this device/i.test(note),
       "the conversation says it is holding something back, rather than leaving a silent gap", note);

    // Filed under the signed-in person: two accounts on one browser must not
    // inherit each other's hidden lists. One of them hiding a message is not a
    // statement about what the other should see.
    const scoped = await dp.page.evaluate(() =>
      Object.keys(JSON.parse(localStorage.getItem("pm-hidden-v1") || "{}")));
    ok(scoped.length === 1 && scoped[0] !== "anon",
       "the record is filed under the signed-in person, not under a shared bucket",
       JSON.stringify(scoped));

    // Nothing was destroyed, so it comes back.
    await dp.page.evaluate(() => document.getElementById("pmUnhide").click());
    await sleep(400);
    const back = await dp.page.$$eval("#pmLog .pm-msg", (ns) => ns.map((n) => n.textContent));
    ok(back.length === 2 && back.some((b) => b.indexOf(DROP) >= 0),
       "and Show them puts it back, which is what makes hiding safe to offer",
       String(back.length));
    ok(!(await dp.page.$("#pmLog .pm-hidnote")), "with the note gone once nothing is hidden");

    // Hide it again and reload. The stub's message table is rebuilt on every
    // page load, so the LOG cannot be the witness here — it would be empty
    // either way, and an assertion that passes for the wrong reason is worse
    // than none. What is checked is the record itself: the store is what has
    // to survive, and the log is what reads it.
    await dp.page.evaluate(() => {
      const all = document.querySelectorAll("#pmLog .pm-msg [data-menu]");
      all[all.length - 1].click();
    });
    await sleep(300);
    await dp.page.evaluate(() => document.getElementById("pmMmDel").click());
    await sleep(250);
    await dp.page.evaluate(() => document.getElementById("pmDelYes").click());
    await sleep(400);
    const kept = await dp.page.evaluate(() => {
      const mine = JSON.parse(localStorage.getItem("pm-hidden-v1") || "{}");
      return Object.values(mine).map((v) => Object.keys(v).length);
    });
    await dp.page.reload({ waitUntil: "domcontentloaded" });
    await sleep(1700);
    const after2 = await dp.page.evaluate(() => {
      const mine = JSON.parse(localStorage.getItem("pm-hidden-v1") || "{}");
      return Object.values(mine).map((v) => Object.keys(v).length);
    });
    ok(JSON.stringify(kept) === JSON.stringify(after2) && after2[0] === 1,
       "and the record survives a reload, so a hidden message stays hidden",
       JSON.stringify(after2));

    await dp.page.evaluate(() => localStorage.removeItem("pm-hidden-v1"));
    ok(dp.errs.length === 0, "no page errors", dp.errs.slice(0, 3).join(" | "));
    await dp.page.close();
  }

  section("14. The storefront — agent.html?u=<user id>");
  // The screen that did not exist: somebody could see "6 rooms" and had to
  // open a conversation to find out what those six rooms were.
  {
    const dp = await openPage("someone@example.com", { path: "agent.html?u=agent_juma", peerKey: PEER_KEY });
    await sleep(1800);

    const card = await dp.page.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const msg = q("#agMsg");
      // .agc-*, not .ag-*. Identity, the numbers and the bio moved out of this
      // page into js/lib/agent-card.js when profile.html started drawing the
      // same storefront under "Your public page". Both screens now render one
      // block from one pm_agent_card row, so a preview cannot reassure an
      // agent about a page that says something else. What is still .ag-* is
      // what only this page has: the card around it and the actions under it.
      return {
        name: (q(".agc-name") || {}).textContent || "",
        area: (q(".agc-area") || {}).textContent || "",
        seen: (q(".pm-seen") || {}).textContent || "",
        kinds: Array.from(document.querySelectorAll(".ag-card .pm-kind")).map((k) => k.textContent.trim()),
        bio: (q(".agc-bio") || {}).textContent || "",
        bioNone: !!q(".agc-bio.is-none"),
        msg: msg ? msg.getAttribute("href") : null,
      };
    });
    ok(/Juma Mwanga/.test(card.name), "the page says who this is", card.name);
    ok(/Nyamagana/.test(card.area), "and where they work", card.area);
    ok(/Online/i.test(card.seen), "and whether they are there right now", card.seen);
    ok(card.kinds.length > 0, "and what kind of work they do", JSON.stringify(card.kinds));
    ok(card.bioNone && card.bio.trim().length > 0,
       "a bio nobody wrote is SAID to be missing rather than left as a blank space", card.bio);
    ok(card.msg === "p-message.html?to=agent_juma",
       "and the one action leads back into an encrypted conversation", String(card.msg));

    const items = await dp.page.$$eval(".ag-item", (ns) => ns.map((n) => ({
      href: n.getAttribute("href"),
      title: (n.querySelector(".ag-t") || {}).textContent || "",
      kind: (n.querySelector(".pm-kind") || {}).textContent || "",
      price: (n.querySelector(".ag-price") || {}).textContent || "",
    })));
    ok(items.length === 2, "their listings are on the page", String(items.length));
    ok(!!items[0] && items[0].href === "house.html?id=h-1",
       "each card leads to the listing's own page", items[0] && items[0].href);
    ok(!!items[0] && /Two rooms/.test(items[0].title), "with its title", items[0] && items[0].title);
    ok(!!items[0] && /Apartment/i.test(items[0].kind),
       "and its kind in words, not as a slug", items[0] && items[0].kind);
    ok(!!items[0] && /250k/.test(items[0].price),
       "and a price you can read at a glance", items[0] && items[0].price);

    // The storefront and the row that led to it must offer the SAME number,
    // from the same column, or two screens are printing two different ways of
    // ringing one person, which is worse than either printing none.
    const call = await dp.page.evaluate(() => {
      const a = document.getElementById("agCall");
      return a ? { href: a.getAttribute("href"), ghost: a.classList.contains("ghost") } : null;
    });
    ok(!!call && call.href === "tel:0712345678",
       "the number they printed on their own listings is offered here too, identically to the agent list",
       JSON.stringify(call));
    ok(!!call && call.ghost,
       "and it is the quieter of the two, because writing to them is the encrypted half");

    // What is STILL never returned is agent_profiles.phone: that number was
    // given under a policy saying only its owner and an admin may read it.
    // Only pm_agent_card and pm_agent_listings are asked for anything here.
    const asked = await dp.page.evaluate(() => (window.__PM_SENT || []).map((c) => c.name));
    ok(asked.every((n) => !/profile/i.test(n)),
       "and nothing on this page reads the private profile row to get it", JSON.stringify(asked));

    ok(dp.errs.length === 0, "no page errors", dp.errs.slice(0, 3).join(" | "));
    await dp.page.close();
  }

  section("14b. A storefront for somebody who is not there");
  {
    const dp = await openPage("someone@example.com", { path: "agent.html?u=nobody_at_all" });
    await sleep(1600);
    const txt = await dp.page.evaluate(() => document.getElementById("agCard").textContent);
    ok(/nobody here/i.test(txt), "an id nobody owns says so, plainly", txt.trim().slice(0, 90));
    ok(!(await dp.page.$(".ag-item")), "and lists nothing");
    ok(dp.errs.length === 0, "with no page errors", dp.errs.slice(0, 3).join(" | "));
    await dp.page.close();

    const none = await openPage("someone@example.com", { path: "agent.html" });
    await sleep(1500);
    const t2 = await none.page.evaluate(() => document.getElementById("agCard").textContent);
    ok(/No agent chosen/i.test(t2), "and a link with no id says what to do instead", t2.trim().slice(0, 90));
    ok(none.errs.length === 0, "with no page errors", none.errs.slice(0, 3).join(" | "));
    await none.page.close();
  }

  process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
} finally {
  await browser.close();
}
process.exit(fail === 0 ? 0 : 1);
