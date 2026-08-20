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
      isAdmin: !!email && admins.map(function (e) { return e.toLowerCase(); })
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

  function inbox() { return rpc("pm_inbox").then(function (r) { return r || []; }); }

  // The person on the other side of a thread, for the safety-number check.
  // Not a directory lookup: guests are deliberately absent from the directory,
  // so an agent verifying a guest would have found nobody.
  function peer(userId) {
    return rpc("pm_peer", { p_user_id: userId }).then(function (r) { return (r && r[0]) || null; });
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
        };
      });
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
  function groupLeave(threadId) { return rpc("pm_group_leave", { p_thread: threadId }); }
  function groupRemove(threadId, userId) {
    return rpc("pm_group_remove", { p_thread: threadId, p_user: userId });
  }
  function groupMax() { return rpc("pm_group_max"); }

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
      try {
        if (r.generation !== null && r.generation !== undefined) {
          var key = senderKeys[r.sender_id + "|" + r.generation];
          if (!key) throw new Error("no sender key for this generation");
          text = await window.PMCrypto.openWithSenderKey(r, key);
        } else {
          text = await window.PMCrypto.open(r, identity);
        }
      } catch (_) { failed = true; }
      out.push({
        id: r.id, at: r.sent_at, senderId: r.sender_id, senderName: r.sender_name,
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
  async function sendWithSenderKey(threadId, body, generation, recipients) {
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
    });
    mine.seq += 1;
    skSave(threadId, generation, mine);
    return { at: new Date().toISOString(), text: body, mine: true };
  }

  async function send(threadId, plaintext) {
    if (!identity) throw new Error("NO_IDENTITY");
    var body = String(plaintext == null ? "" : plaintext).trim();
    if (!body) return null;

    var recipients = await threadKeys(threadId);
    if (!recipients.length) throw new Error("NOBODY_REACHABLE");

    if (recipients.length > SK_THRESHOLD) {
      var meta = await threadMeta(threadId);
      if (meta.kind === "group") {
        return sendWithSenderKey(threadId, body, meta.key_generation || 0, recipients);
      }
    }

    var sealed = await window.PMCrypto.seal({
      threadId: threadId, senderId: identity.userId,
      recipients: recipients, plaintext: body,
    });
    await rpc("pm_send", {
      p_thread: threadId, p_iv: sealed.iv,
      p_ciphertext: sealed.ciphertext, p_keys: sealed.keys,
    });
    return { at: new Date().toISOString(), text: body, mine: true };
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
    var people = await recipients(opts.region);
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

  window.PMStore = {
    me: me,
    signInAsGuest: signInAsGuest,
    ensureIdentity: ensureIdentity,
    restoreIdentity: restoreIdentity,
    current: current,
    directory: directory,
    inbox: inbox,
    peer: peer,
    startDirect: startDirect,
    markRead: markRead,
    threadKeys: threadKeys,
    messages: messages,
    send: send,
    recipients: recipients,
    broadcast: broadcast,
    subscribe: subscribe,
    groupCandidates: groupCandidates,
    groupCreate: groupCreate,
    groupAdd: groupAdd,
    groupLeave: groupLeave,
    groupRemove: groupRemove,
    groupMax: groupMax,
    inviteCreate: inviteCreate,
    invitePeek: invitePeek,
    inviteAccept: inviteAccept,
    invitesMine: invitesMine,
    inviteRevoke: inviteRevoke,
  };
})();
