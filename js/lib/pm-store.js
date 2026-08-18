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
      // The claim is checked again in the database by is_admin() on every
      // privileged call. This is only for deciding what to DRAW.
      isAdmin: !!email && admins.map(function (e) { return e.toLowerCase(); })
        .indexOf(String(email).toLowerCase()) >= 0,
    };
    return meCache;
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
  function startDirect(userId) { return rpc("pm_start_direct", { p_other: userId }); }
  function markRead(threadId) { return rpc("pm_mark_read", { p_thread: threadId }); }

  /**
   * The public keys of everyone in a thread — the address book for sealing.
   *
   * A member with no published key is dropped, not silently included: they have
   * never opened P-Message on any device, so there is no key to encrypt to and
   * nothing to be done about it here. The caller reports how many were reached.
   */
  async function threadKeys(threadId) {
    var client = sb();
    var mem = await client.from("pm_members").select("user_id").eq("thread_id", threadId);
    if (mem.error) throw new Error(mem.error.message);
    var ids = (mem.data || []).map(function (m) { return m.user_id; });
    if (!ids.length) return [];
    var keys = await client.from("pm_keys").select("user_id, public_key").in("user_id", ids);
    if (keys.error) throw new Error(keys.error.message);
    return (keys.data || []).map(function (k) {
      keyCache[k.user_id] = k.public_key;
      return { userId: k.user_id, publicKey: k.public_key };
    });
  }

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
    var out = [];
    for (var i = 0; i < (rows || []).length; i++) {
      var r = rows[i], text = null, failed = false;
      try {
        text = await window.PMCrypto.open(r, identity);
      } catch (_) { failed = true; }
      out.push({
        id: r.id, at: r.sent_at, senderId: r.sender_id, senderName: r.sender_name,
        mine: r.sender_id === identity.userId, text: text, failed: failed,
      });
    }
    return out;
  }

  // ---- writing --------------------------------------------------------------
  async function send(threadId, plaintext) {
    if (!identity) throw new Error("NO_IDENTITY");
    var body = String(plaintext == null ? "" : plaintext).trim();
    if (!body) return null;

    var recipients = await threadKeys(threadId);
    if (!recipients.length) throw new Error("NOBODY_REACHABLE");

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
    ensureIdentity: ensureIdentity,
    restoreIdentity: restoreIdentity,
    current: current,
    directory: directory,
    inbox: inbox,
    startDirect: startDirect,
    markRead: markRead,
    threadKeys: threadKeys,
    messages: messages,
    send: send,
    recipients: recipients,
    broadcast: broadcast,
    subscribe: subscribe,
  };
})();
