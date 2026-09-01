// ============================================================================
//  pm-store.js — everything P-Message does that is not drawing.
//
//  The page (js/pages/p-message.js) renders; this file owns identity, the
//  network calls, and the one rule that matters: plaintext exists only inside
//  this process. It goes into PMCrypto.seal() before it reaches Supabase and
//  comes out of PMCrypto.open() after. Nothing here ever posts a message body.
//
//  Depends on js/lib/p-crypto.js (the sealing) and window.DataStore.sb (the
//  Supabase client). No DOM, so it can be driven from a test.
// ============================================================================

(function () {
  "use strict";

  var identity = null;      // { userId, publicKey, privateKey }
  var meCache = null;
  var keyCache = {};        // user_id -> public_key, within a page life

  function sb() {
    return (window.DataStore && window.DataStore.sb) || window.SB || null;
  }

  function rpc(name, args) {
    var client = sb();
    if (!client) return Promise.reject(new Error("Not connected."));
    return client.rpc(name, args || {}).then(function (res) {
      if (res.error) throw new Error(res.error.message || String(res.error));
      return res.data;
    });
  }

  // ---- who am I -------------------------------------------------------------
  async function me(fresh) {
    if (meCache && !fresh) return meCache;
    var client = sb();
    if (!client) return (meCache = { userId: null });
    var got = await client.auth.getSession();
    var session = got && got.data && got.data.session;
    if (!session || !session.user) return (meCache = { userId: null });
    var email = session.user.email || null;
    var admins = (window.APP_CONFIG && window.APP_CONFIG.ADMIN_EMAILS) || [];
    meCache = {
      userId: session.user.id,
      email: email,
      // A guest is a real authenticated user who has not proved who they are.
      // Supabase marks the session; the database checks the same claim itself
      // in app_is_guest(), so this is only for deciding what to DRAW.
      isGuest: session.user.is_anonymous === true,
      // Likewise checked again by is_admin() on every privileged call.
      // The anonymous test is belt and braces: a guest has no email so the
      // list can never match one, but this value decides what gets DRAWN on
      // five screens, and "an admin is never a guest" should be stated where
      // the flag is made rather than assumed at each of them.
      isAdmin: session.user.is_anonymous !== true && !!email &&
        admins.map(function (e) { return e.toLowerCase(); })
          .indexOf(String(email).toLowerCase()) >= 0,
    };
    return meCache;
  }

  /**
   * Start a guest session — an account-less person messaging an agent.
   *
   * It is a real anonymous Supabase user, so app_uid() resolves, RLS applies
   * and the encryption is bit-for-bit what a signed-in agent gets. What a
   * guest does NOT get is the run of the database: p_message_guests.sql fences
   * every content-creating policy with `not app_is_guest()`, so this cannot
   * become a free way to post listings.
   *
   * The session lives in this browser, exactly like the encryption key. Say so
   * in the UI: clearing the browser loses both the thread and the ability to
   * read it.
   */
  async function signInAsGuest(displayName, region) {
    var client = sb();
    if (!client) throw new Error("Not connected.");
    var name = String(displayName || "").trim();
    if (name.length < 2) throw new Error("SHORT_NAME");

    var res = await client.auth.signInAnonymously();
    if (res.error) throw new Error(res.error.message || String(res.error));
    meCache = null;
    identity = null;
    var who = await me(true);
    if (!who.userId) throw new Error("Could not start a guest session.");
    return ensureIdentity({ displayName: name, region: region || null });
  }

  // ---- identity -------------------------------------------------------------
  /**
   * Make sure this device has a keypair and the network knows its public half.
   *
   * Publishing every time is deliberate: it is an upsert, it costs one small
   * call, and it repairs the case where the key was generated but the publish
   * failed — which would otherwise leave someone permanently invisible to
   * everyone trying to write to them, with no symptom on their own screen.
   */
  async function ensureIdentity(opts) {
    opts = opts || {};
    var who = await me();
    if (!who.userId) throw new Error("SIGNED_OUT");
    if (!window.PMCrypto || !window.PMCrypto.available()) throw new Error("NO_CRYPTO");

    // A locked device HAS an identity; it just has not been opened yet.
    // Reaching the branch below in that state would mint a second keypair and
    // publish it, and every message received under the first would become
    // permanently unreadable. This is the only thing standing between a
    // forgotten unlock and silent data loss.
    if (window.PMDeviceLock && window.PMDeviceLock.isLocked()) throw new Error("LOCKED");

    var stored = window.PMCrypto.load();
    var fresh = false;
    if (!stored) {
      stored = await window.PMCrypto.generateIdentity();
      window.PMCrypto.save(stored);
      fresh = true;
    }
    identity = { userId: who.userId, publicKey: stored.publicKey, privateKey: stored.privateKey };

    var fp = await window.PMCrypto.fingerprint(stored.publicKey);
    await rpc("pm_publish_key", {
      p_public_key: stored.publicKey,
      p_fingerprint: fp,
      p_display_name: opts.displayName || null,
      p_region: opts.region || null,
    });
    return { identity: identity, fingerprint: fp, isNewDevice: fresh };
  }

  /**
   * Point this device's ALREADY-GENERATED identity at the current session,
   * without publishing anything.
   *
   * ensureIdentity() is the door for a page whose job is P-Message: it mints a
   * keypair when there is none and upserts the public half every time. Both are
   * right there and wrong anywhere else. A page that only wants to READ what it
   * already has — the listing form asking "which pins have people sent me?" —
   * must not mint a key as a side effect of being opened, because that key
   * would become this account's published key and every message sent under the
   * real one, on the real device, would stop opening.
   *
   * So this refuses in exactly the cases ensureIdentity() would act:
   * no session, no crypto, a locked device, or no stored key. Returns null and
   * writes nothing. The caller shows the reason; it never invents an identity.
   */
  async function attach() {
    if (identity) return identity;
    var who = await me();
    if (!who.userId) return null;
    if (!window.PMCrypto || !window.PMCrypto.available()) return null;
    if (window.PMDeviceLock && window.PMDeviceLock.isLocked()) return null;
    var stored = window.PMCrypto.load();
    if (!stored) return null;
    identity = { userId: who.userId, publicKey: stored.publicKey, privateKey: stored.privateKey };
    return identity;
  }

  function current() { return identity; }

  /** Replace this device's identity from a backup code, then republish it. */
  async function restoreIdentity(blob, passphrase) {
    var restored = await window.PMCrypto.restore(blob, passphrase);
    window.PMCrypto.save(restored);
    identity = null;
    return ensureIdentity();
  }

  // ---- people ---------------------------------------------------------------
  function directory(opts) {
    opts = opts || {};
    return rpc("pm_directory", {
      p_region: opts.region || null,
      p_query: opts.query || null,
      p_limit: opts.limit || 200,
    }).then(function (rows) {
      (rows || []).forEach(function (r) { if (r.public_key) keyCache[r.user_id] = r.public_key; });
      return rows || [];
    });
  }

  /**
   * The directory again, but carrying WHAT EACH PERSON DEALS IN.
   *
   * directory() answers "who is out there". This answers "who can help me
   * move a fridge in Nyamagana", because it brings back the listing counts per
   * category, the point the agent picked for their area, and when they last
   * touched anything. js/lib/pm-match.js turns those columns into an order.
   *
   * Kept beside directory() rather than replacing it: the older callers and
   * their stubs are built around that return shape, and a page that only needs
   * names should not have to pay for four count sub-selects per row.
   *
   * `category` is one of houses / services / trucks / jobs, or null. Anything
   * else matches NOBODY rather than everybody — the database says so and
   * pm-match.js agrees — because a typo that silently widens a filter is a
   * screen full of people who cannot help.
   */
  function finder(opts) {
    opts = opts || {};
    return rpc("pm_agent_finder", {
      p_region: opts.region || null,
      p_query: opts.query || null,
      p_category: opts.category || null,
      p_limit: opts.limit || 300,
    }).then(function (rows) {
      (rows || []).forEach(function (r) { if (r.public_key) keyCache[r.user_id] = r.public_key; });
      return rows || [];
    });
  }

  function inbox() { return rpc("pm_inbox").then(function (r) { return r || []; }); }

  // ---- presence -------------------------------------------------------------
  // "This device has P-Message open." Called by js/lib/pm-presence.js on a
  // one-minute beat and nowhere else — the claim on screen is "last opened
  // P-Message", so a beat from any other page would silently weaken it.
  // The RPC skips the write when the stored value is already fresh.
  function touchSeen() { return rpc("pm_touch_seen"); }

  // How long a beat counts for, straight from the database, so the dot and
  // the thing keeping it lit cannot disagree.
  function onlineWindow() { return rpc("pm_online_window"); }

  /**
   * One agent's storefront: who they are, and everything they list.
   *
   * Two calls rather than one because they fail differently and are drawn
   * differently — the card is the page's identity and must be on screen
   * before the catalogue finishes, and an agent with no listings still has
   * a card. The page renders the first the moment it lands.
   */
  function agentCard(userId) {
    return rpc("pm_agent_card", { p_user: userId }).then(function (rows) {
      return (rows && rows[0]) || null;
    });
  }

  function agentListings(userId, limit) {
    return rpc("pm_agent_listings", { p_user: userId, p_limit: limit || 60 })
      .then(function (r) { return r || []; });
  }

  // A v2 safety number is six groups of five digits. Anything else on the
  // server is a leftover from the 12-digit scheme and carries no signal, so it
  // is not compared — see the tamper note below.
  var FP_V2 = /^\d{5}( \d{5}){5}$/;

  /**
   * The person on the other side of a thread, for the safety-number check.
   *
   * Not a directory lookup: guests are deliberately absent from the directory,
   * so an agent verifying a guest would have found nobody.
   *
   * THE NUMBER IS DERIVED HERE, from the public key that actually arrived. It
   * used to be read straight out of pm_keys.fingerprint, which made the whole
   * safety-number ritual theatre: anybody able to substitute the key in that
   * row can write the fingerprint column beside it, so the two phones would
   * show matching numbers for a key neither person owned. A number supplied by
   * the attacker cannot catch the attacker.
   *
   * Every call also pins the key (see js/lib/pm-trust.js), which is what makes
   * a LATER substitution visible rather than merely a first one honest.
   */
  async function peer(userId) {
    var rows = await rpc("pm_peer", { p_user_id: userId });
    var row = (rows && rows[0]) || null;
    if (!row) return null;
    if (row.public_key) keyCache[userId] = row.public_key;

    var derived = row.public_key ? await window.PMCrypto.fingerprint(row.public_key) : "";
    var trust = (identity && row.public_key && window.PMTrust)
      ? window.PMTrust.record(identity.userId, userId, row.public_key, row.display_name)
      : null;

    return {
      userId: row.user_id,
      displayName: row.display_name,
      publicKey: row.public_key,
      fingerprint: derived,
      // Reported, never trusted, and nothing is decided by it: a disagreement
      // means somebody wrote to that row. Only compared when the stored value
      // is a v2 number at all, or every account still carrying a 12-digit one
      // would raise a false alarm until its owner next opens the page.
      tampered: !!(row.fingerprint && derived &&
                   FP_V2.test(row.fingerprint) && row.fingerprint !== derived),
      isAgent: row.is_agent,
      isGuest: row.is_guest,
      region: row.region,
      // Where they work. The conversation header knew only a name until now,
      // which is the one thing that does not help you decide whether this is
      // the person who can find you a room in Nyamagana.
      area: row.area || null,
      areaKind: row.area_kind || null,
      district: row.district || null,
      ward: row.ward || null,
      // Null when they have not opened P-Message since presence shipped.
      // The header draws nothing for null rather than guessing — see
      // js/lib/pm-presence.js.
      lastSeenAt: row.last_seen_at || null,
      trust: trust,
    };
  }
  function startDirect(userId) { return rpc("pm_start_direct", { p_other: userId }); }
  function markRead(threadId) { return rpc("pm_mark_read", { p_thread: threadId }); }

  /**
   * The public keys of everyone in a thread — the address book for sealing.
   *
   * A member with no published key is dropped, not silently included: they have
   * never opened P-Message on any device, so there is no key to encrypt to and
   * nothing to be done about it here. The caller reports how many were reached.
   */
  // One RPC, not two table reads. The old shape fetched pm_members and then
  // pm_keys and joined them here, which is two round trips on a Tanzanian
  // mobile network for every single message sent — and in a room of 200 the
  // `.in(ids)` was a URL long enough to be worth worrying about.
  async function threadKeys(threadId) {
    var rows = await rpc("pm_thread_keys", { p_thread: threadId });
    return (rows || []).filter(function (k) { return k.public_key; })
      .map(function (k) {
        keyCache[k.user_id] = k.public_key;
        return {
          userId: k.user_id, publicKey: k.public_key,
          name: k.display_name, role: k.role, isGuest: k.is_guest,
          // The roster sheet is built from THIS call rather than a second one,
          // so that the list of people a message is sealed to and the list the
          // screen shows can never disagree about who is in the room.
          isAgent: !!k.is_agent, region: k.region || null,
          area: k.area || null, areaKind: k.area_kind || null,
          district: k.district || null, ward: k.ward || null,
          joinedAt: k.joined_at || null,
        };
      });
  }

  /** How many people are in a thread, without dragging the roster back. */
  function threadSize(threadId) {
    return rpc("pm_thread_size", { p_thread: threadId })
      .then(function (n) { return Number(n) || 0; });
  }

  // ---- rooms ----------------------------------------------------------------
  // The admin's "who would be in this" preview. Returns nothing at all to a
  // non-admin, so the UI can simply not show the button rather than guard it.
  function groupCandidates(category, region) {
    return rpc("pm_group_candidates", {
      p_category: category || null,
      p_region: region || null,
    }).then(function (r) { return r || []; });
  }

  /**
   * Who an announcement would reach, resolved ONCE.
   *
   * The preview and the send have to be the same question or the preview is
   * decoration: a screen that says "412 people" and then a call that asks the
   * database again has shown a number about a different set. So this returns
   * the rows, the screen counts them, and broadcast() is handed the very same
   * array rather than a scope to re-resolve.
   *
   * Without a category it is everyone with a key (minus guests) — that is what
   * an announcement is. With one it narrows to people who actually list in
   * that category, which is a different and much smaller question, and
   * pm_group_candidates is the function that already answers it.
   */
  function audience(opts) {
    opts = opts || {};
    return opts.category
      ? groupCandidates(opts.category, opts.region)
      : recipients(opts.region);
  }

  function groupCreate(opts) {
    return rpc("pm_group_create", {
      p_title: String((opts && opts.title) || "").trim(),
      p_category: (opts && opts.category) || null,
      p_region: (opts && opts.region) || null,
      p_members: (opts && opts.members) || [],
    });
  }

  function groupAdd(threadId, members) {
    return rpc("pm_group_add", { p_thread: threadId, p_members: members || [] });
  }
  /**
   * Leave a room, and find out what leaving DID.
   *
   * Four answers, because the screen has to say something different to each:
   * "left" (ordinary), "handed_over" (you owned it and somebody else does
   * now), "deleted" (you were the last one, so the room is gone), and
   * "not_member" (you were not in it, which is not an error).
   */
  function groupLeave(threadId) {
    return rpc("pm_group_leave", { p_thread: threadId })
      .then(function (r) { return r || "left"; });
  }
  function groupRemove(threadId, userId) {
    return rpc("pm_group_remove", { p_thread: threadId, p_user: userId });
  }
  /**
   * Close a room for everyone. The room's CURRENT owner, or an admin: an owner
   * who leaves hands the room on, and keying this to whoever opened it would
   * leave rooms nobody alive could close.
   */
  function groupDelete(threadId) { return rpc("pm_group_delete", { p_thread: threadId }); }
  function groupMax() { return rpc("pm_group_max"); }

  /**
   * Unsend one message.
   *
   * Returns the time it was withdrawn, so the caller can draw the tombstone
   * without refetching the thread. Calling it twice is safe and returns the
   * FIRST deletion: a person tapping through a slow connection meant it once.
   */
  /**
   * End a guest identity on the SERVER as well as on this device.
   *
   * Signing out only ever forgot the private key locally, which left the guest
   * published in pm_keys and sitting in every thread they had joined: still
   * reachable, and unable to read anything sent to them ever again. This drops
   * the key row and the memberships.
   *
   * `wipeMessages` is opt-in and off by default, because what a guest sent is
   * also the other person's half of a conversation.
   *
   * Returns { threads, messages }.
   */
  function guestForget(wipeMessages) {
    return rpc("pm_guest_forget", { p_wipe_messages: !!wipeMessages })
      .then(function (r) { return r || { threads: 0, messages: 0 }; });
  }

  function messageDelete(messageId) {
    return rpc("pm_message_delete", { p_message: messageId });
  }

  // ---- invite links ---------------------------------------------------------
  // The token is generated here and NEVER sent to the server — only its
  // sha256. That is the whole security property of the feature, so it is
  // written once, here, rather than assembled at a call site.
  function b64u(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  async function sha256Hex(str) {
    var buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
    var b = new Uint8Array(buf), out = "";
    for (var i = 0; i < b.length; i++) out += b[i].toString(16).padStart(2, "0");
    return out;
  }

  /**
   * Make an invite. Returns { token, link, expiresAt } — the token is the only
   * copy that will ever exist, so a caller that loses it cannot recover it and
   * must make another.
   */
  async function inviteCreate(label, days) {
    var raw = new Uint8Array(32);
    crypto.getRandomValues(raw);
    var token = b64u(raw);
    var rows = await rpc("pm_invite_create", {
      p_token_hash: await sha256Hex(token),
      p_label: label || null,
      p_days: days || 14,
    });
    var row = (rows && rows[0]) || {};
    return {
      token: token,
      hash: row.token_hash,
      expiresAt: row.expires_at,
      link: location.origin + location.pathname.replace(/[^/]*$/, "") +
            "p-message.html?i=" + encodeURIComponent(token),
    };
  }

  function invitePeek(token) {
    return rpc("pm_invite_peek", { p_token: token })
      .then(function (r) { return (r && r[0]) || null; });
  }
  function inviteAccept(token) { return rpc("pm_invite_accept", { p_token: token }); }
  function invitesMine(limit) {
    return rpc("pm_invites_mine", { p_limit: limit || 50 }).then(function (r) { return r || []; });
  }
  function inviteRevoke(hash) { return rpc("pm_invite_revoke", { p_token_hash: hash }); }

  // ---- reading --------------------------------------------------------------
  /**
   * A thread's messages, decrypted.
   *
   * A message that will not open is kept in the list and marked, never dropped:
   * it means this device's key cannot read it — sent before this device
   * existed, or after a key rotation — and a silently missing message is far
   * more alarming than one that says why it is unreadable.
   */
  async function messages(threadId, limit) {
    if (!identity) throw new Error("NO_IDENTITY");
    var rows = await rpc("pm_thread_messages", { p_thread: threadId, p_limit: limit || 200 });

    // A thread can hold both kinds at once — a room that grew past the
    // threshold has per-recipient messages below and sender-key messages
    // above. The row says which it is: a generation means a sender key.
    var needsSk = (rows || []).some(function (r) { return r.generation !== null && r.generation !== undefined; });
    var senderKeys = {};
    if (needsSk) {
      var handed = await rpc("pm_sender_keys_for", { p_thread: threadId });
      for (var s = 0; s < (handed || []).length; s++) {
        var h = handed[s];
        try {
          senderKeys[h.sender_id + "|" + h.generation] = await window.PMCrypto.openSenderKey({
            thread_id: threadId, sender_id: h.sender_id, generation: h.generation,
            epk: h.epk, wrapped_key: h.wrapped_key,
          }, identity);
        } catch (_) { /* a key we cannot open leaves its messages marked, below */ }
      }
    }

    var out = [];
    for (var i = 0; i < (rows || []).length; i++) {
      var r = rows[i], text = null, failed = false;
      var gone = !!r.deleted_at;
      // A withdrawn message is not a decryption that went wrong, and it must
      // never be reported as one. Its ciphertext and every wrap for it are
      // gone from the server, so trying would fail, and "could not read this"
      // is the screen telling somebody their key is broken when the truth is
      // that the sender took it back.
      if (!gone) {
        try {
          if (r.generation !== null && r.generation !== undefined) {
            var key = senderKeys[r.sender_id + "|" + r.generation];
            if (!key) throw new Error("no sender key for this generation");
            text = await window.PMCrypto.openWithSenderKey(r, key);
          } else {
            text = await window.PMCrypto.open(r, identity);
          }
        } catch (_) { failed = true; }
      }
      out.push({
        id: r.id, at: r.sent_at, senderId: r.sender_id, senderName: r.sender_name,
        // The message this one answers, as an ID and nothing more. The quoted
        // WORDS are never sent from the server: the page pairs this with the
        // copy it just decrypted, so a reply can never display text the
        // original did not contain, and a reply to something this device may
        // not read shows a neutral placeholder instead of leaking it.
        replyTo: r.reply_to || null,
        // In a room the name beside a message is one the sender chose for
        // themselves. Saying which of those people never proved who they are
        // is the difference between "the agent said so" and "somebody calling
        // themselves that said so".
        senderGuest: !!r.sender_guest,
        // When it was withdrawn, or null. The page draws a tombstone from
        // this; nothing else about the message survives on the server.
        deletedAt: r.deleted_at || null,
        mine: r.sender_id === identity.userId, text: text, failed: failed,
      });
    }
    return out;
  }

  // ---- writing --------------------------------------------------------------
  // Above this many members a room switches to sender keys. Below it the
  // simpler per-message path is cheap enough, and fewer moving parts wins.
  var SK_THRESHOLD = 25;
  var SK_STORE = "pm-sender-keys-v1";   // { "<thread>|<gen>": { raw, seq } }

  function skAll() {
    try { return JSON.parse(localStorage.getItem(SK_STORE) || "{}"); } catch (_) { return {}; }
  }
  function skLoad(threadId, generation) {
    return skAll()[threadId + "|" + generation] || null;
  }
  function skSave(threadId, generation, rec) {
    try {
      var all = skAll();
      all[threadId + "|" + generation] = rec;
      localStorage.setItem(SK_STORE, JSON.stringify(all));
    } catch (_) {}
  }

  // kind + key_generation, straight off the thread. RLS already restricts this
  // to members, so there is no RPC to wrap it in.
  async function threadMeta(threadId) {
    var client = sb();
    var r = await client.from("pm_threads")
      .select("kind, key_generation, title, region, category").eq("id", threadId).limit(1);
    if (r.error) throw new Error(r.error.message);
    return (r.data && r.data[0]) || { kind: "direct", key_generation: 0 };
  }

  /**
   * Send under a sender key.
   *
   * The generation comes from the SERVER, never from local memory: the room
   * may have changed since this device last looked, and sending under a stale
   * generation is exactly the mistake that would leak to someone who was
   * removed. pm_send_sk() refuses it anyway — this just avoids the round trip
   * that ends in an error.
   */
  async function sendWithSenderKey(threadId, body, generation, recipients, replyTo) {
    var mine = skLoad(threadId, generation);
    if (!mine) {
      // First message of this generation: pay the one-time distribution.
      var fresh = window.PMCrypto.newSenderKey(generation);
      var wraps = await window.PMCrypto.distributeSenderKey({
        threadId: threadId, senderId: identity.userId,
        generation: generation, senderKey: fresh.raw, recipients: recipients,
      });
      await rpc("pm_sender_key_put", {
        p_thread: threadId, p_generation: generation, p_keys: wraps,
      });
      mine = { raw: fresh.raw, seq: 0 };
      skSave(threadId, generation, mine);
    }

    var sealed = await window.PMCrypto.sealWithSenderKey({
      threadId: threadId, senderId: identity.userId, generation: generation,
      seq: mine.seq, senderKey: mine.raw, plaintext: body,
    });
    await rpc("pm_send_sk", {
      p_thread: threadId, p_generation: generation, p_seq: mine.seq,
      p_iv: sealed.iv, p_ciphertext: sealed.ciphertext,
      p_reply_to: replyTo || null,
    });
    mine.seq += 1;
    skSave(threadId, generation, mine);
    return { at: new Date().toISOString(), text: body, mine: true, replyTo: replyTo || null };
  }

  /**
   * @param {string} threadId
   * @param {string} plaintext
   * @param {{replyTo?: string}} [opts] the id of the message being answered.
   *   Optional third argument rather than a fourth positional one so every
   *   existing caller keeps working, and so the id has a name at the call
   *   site — send(t, text, someUuid) would read as anybody's guess.
   */
  async function send(threadId, plaintext, opts) {
    if (!identity) throw new Error("NO_IDENTITY");
    var body = String(plaintext == null ? "" : plaintext).trim();
    if (!body) return null;

    var recipients = await threadKeys(threadId);
    if (!recipients.length) throw new Error("NOBODY_REACHABLE");

    var replyTo = (opts && opts.replyTo) || null;

    if (recipients.length > SK_THRESHOLD) {
      var meta = await threadMeta(threadId);
      if (meta.kind === "group") {
        return sendWithSenderKey(threadId, body, meta.key_generation || 0, recipients, replyTo);
      }
    }

    var sealed = await window.PMCrypto.seal({
      threadId: threadId, senderId: identity.userId,
      recipients: recipients, plaintext: body,
    });
    await rpc("pm_send", {
      p_thread: threadId, p_iv: sealed.iv,
      p_ciphertext: sealed.ciphertext, p_keys: sealed.keys,
      p_reply_to: replyTo,
    });
    return { at: new Date().toISOString(), text: body, mine: true, replyTo: replyTo };
  }

  function recipients(region) {
    return rpc("pm_recipients", { p_region: region || null }).then(function (r) { return r || []; });
  }

  /**
   * An admin announcement to a region, or to the whole country.
   *
   * One body encryption, one key wrap per person. `onProgress` exists because
   * a thousand wraps is several seconds of a phone's CPU and a screen that
   * appears frozen during it will be tapped again.
   */
  async function broadcast(opts) {
    if (!identity) throw new Error("NO_IDENTITY");
    // An announcement can now be scoped by what people deal in as well as by
    // where they are, and the screen shows WHO it caught before it is sent.
    // The audience it previewed is therefore handed straight back here: if
    // this function went and asked again, the preview would be a different
    // query from the send, and the one thing a preview has to be is the same
    // question. Without a preview it falls back to asking, exactly as before.
    var people = (opts.members && opts.members.length)
      ? opts.members
      : await recipients(opts.region);
    var list = people.filter(function (p) { return p.public_key; })
      .map(function (p) { return { userId: p.user_id, publicKey: p.public_key }; });
    if (!list.length) throw new Error("NOBODY_REACHABLE");
    if (opts.onProgress) opts.onProgress({ phase: "sealing", total: list.length });

    // The thread id is chosen HERE so the body can be sealed against it — the
    // same binding a direct message gets. pm_broadcast() takes it as given.
    var threadId = (window.crypto && window.crypto.randomUUID)
      ? window.crypto.randomUUID() : null;

    var sealed = await window.PMCrypto.seal({
      threadId: threadId, senderId: identity.userId,
      recipients: list, plaintext: String(opts.text || "").trim(),
    });
    if (opts.onProgress) opts.onProgress({ phase: "sending", total: list.length });

    var id = await rpc("pm_broadcast", {
      p_title: opts.title || null, p_region: opts.region || null,
      p_iv: sealed.iv, p_ciphertext: sealed.ciphertext,
      p_keys: sealed.keys, p_thread: threadId,
    });
    return { threadId: id, reached: list.length, skipped: people.length - list.length };
  }

  // ---- live -----------------------------------------------------------------
  // RLS applies to realtime too, so this only ever fires for threads the
  // subscriber belongs to — and the payload it carries is ciphertext.
  function subscribe(threadId, onInsert) {
    var client = sb();
    if (!client || !client.channel) return { unsubscribe: function () {} };
    var ch = client.channel("pm_" + threadId)
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "pm_messages", filter: "thread_id=eq." + threadId },
        function (payload) { onInsert(payload && payload.new); })
      .subscribe();
    return {
      unsubscribe: function () { try { client.removeChannel(ch); } catch (_) {} },
    };
  }

  /**
   * Watch the WHOLE inbox, not one open conversation.
   *
   * subscribe() above is per-thread, and it was the only live delivery there
   * was — so a message arriving in a conversation you did not currently have
   * open was invisible until the page was reloaded. That is not a rough edge
   * on a chat feature; it is the chat feature not working. Two people cannot
   * talk to each other if neither one is told the other replied.
   *
   * Unfiltered, because RLS is the filter: `pm_messages member read` means a
   * subscriber is only ever pushed rows from threads they belong to, and the
   * payload is ciphertext either way. A new conversation somebody else started
   * arrives the same way — its first message is an insert I can see the moment
   * pm_start_direct put me in it.
   *
   * The poll is a fallback, not a duplicate: realtime needs a websocket, and
   * on the networks this is for that connection is the first thing to go. A
   * quiet 25-second poll costs one small query and means the worst case is a
   * slow inbox rather than a silent one.
   */
  function watchInbox(onChange) {
    var client = sb();
    var ch = null, timer = null, stopped = false;
    var fire = function () { if (!stopped) { try { onChange(); } catch (_) {} } };

    if (client && client.channel) {
      try {
        ch = client.channel("pm_inbox_" + Math.random().toString(36).slice(2))
          .on("postgres_changes",
            { event: "INSERT", schema: "public", table: "pm_messages" }, fire)
          .subscribe();
      } catch (_) { ch = null; }
    }
    timer = setInterval(fire, 25000);

    return {
      unsubscribe: function () {
        stopped = true;
        clearInterval(timer);
        if (ch) { try { client.removeChannel(ch); } catch (_) {} }
      },
    };
  }

  window.PMStore = {
    me: me,
    signInAsGuest: signInAsGuest,
    ensureIdentity: ensureIdentity,
    attach: attach,
    restoreIdentity: restoreIdentity,
    current: current,
    directory: directory,
    finder: finder,
    inbox: inbox,
    peer: peer,
    touchSeen: touchSeen,
    onlineWindow: onlineWindow,
    agentCard: agentCard,
    agentListings: agentListings,
    startDirect: startDirect,
    markRead: markRead,
    threadKeys: threadKeys,
    threadSize: threadSize,
    messages: messages,
    send: send,
    recipients: recipients,
    audience: audience,
    broadcast: broadcast,
    subscribe: subscribe,
    watchInbox: watchInbox,
    groupCandidates: groupCandidates,
    groupCreate: groupCreate,
    groupAdd: groupAdd,
    groupLeave: groupLeave,
    groupRemove: groupRemove,
    groupDelete: groupDelete,
    groupMax: groupMax,
    messageDelete: messageDelete,
    guestForget: guestForget,
    inviteCreate: inviteCreate,
    invitePeek: invitePeek,
    inviteAccept: inviteAccept,
    invitesMine: invitesMine,
    inviteRevoke: inviteRevoke,
  };
})();
