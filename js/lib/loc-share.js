// ============================================================================
//  loc-share.js — the network side of a location code.
//
//  js/lib/loc-code.js owns the nine characters and the encryption and knows
//  nothing about Supabase. This owns the four calls and the little list of
//  codes this device has minted, and knows nothing about the maths. Two pages
//  use it — share-location.html and the agent's listing form — so that "enter
//  a code, the pin drops" is one implementation with two doors rather than two
//  implementations that drift.
//
//  THE SHAPE OF A SHARE, in four calls:
//
//    loc_share_ticket()   the server hands out one locator, signed, spendable
//                         once. Anonymous callers may ask: the person standing
//                         at the house usually has no account.
//    loc_share_create()   this device finishes the code, encrypts the place
//                         under it, and posts the ciphertext. The code itself
//                         never leaves the browser.
//    loc_share_open()     the receiver posts the handle derived from the code
//                         they were told. Signed-in accounts only.
//    loc_share_manage()   the sender checks on, or kills, a share — proved by
//                         a token that exists nowhere but this device.
//
//  Every failure comes back as a short reason string rather than an exception,
//  because every one of them is an ordinary thing that happens to people:
//  "expired", "used_up", "revoked", "not_found", "rate_limited", "signin".
//  The page turns those into sentences; this file holds no words.
// ============================================================================

(function () {
  "use strict";

  var STORE_KEY = "loc-shares-v1";     // localStorage: codes minted on this device
  var KEEP = 20;

  function client() {
    return window.SB || (window.DataStore && window.DataStore.sb) || null;
  }

  /** Turn any thrown thing into one of our reason strings. */
  function reasonOf(err) {
    var m = String((err && (err.message || err.code)) || "");
    if (/LOC_BUSY/.test(m)) return "busy";
    if (/LOC_EXHAUSTED/.test(m)) return "exhausted";
    if (/LOC_TICKET_SPENT|LOC_BAD_TICKET|LOC_TICKET_EXPIRED/.test(m)) return "ticket";
    if (/permission denied|not allowed/i.test(m)) return "signin";
    if (/Failed to fetch|NetworkError|network/i.test(m)) return "offline";
    return "failed";
  }

  // ---- the sender's own list -------------------------------------------------
  // The code is kept, deliberately: without it "here is the code you made ten
  // minutes ago" is impossible, and the alternative is people minting a second
  // share because they lost the first. It is on their own device, next to the
  // P-Message private key, and it dies with the site data.
  function mine() {
    var list = [];
    try { list = JSON.parse(localStorage.getItem(STORE_KEY) || "[]"); } catch (_) { list = []; }
    if (!Array.isArray(list)) list = [];
    var now = Date.now();
    return list.filter(function (r) {
      return r && r.code && r.expiresAt && new Date(r.expiresAt).getTime() > now;
    });
  }
  function remember(rec) {
    var list = mine();
    list.unshift(rec);
    try { localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(0, KEEP))); } catch (_) {}
  }
  function forget(handle) {
    var list = mine().filter(function (r) { return r.handle !== handle; });
    try { localStorage.setItem(STORE_KEY, JSON.stringify(list)); } catch (_) {}
  }

  // ---- create ----------------------------------------------------------------
  /**
   * Mint a code for a place.
   *
   * `place` is { lat, lng, acc, label }. `ttlMinutes` and `maxOpens` are hints:
   * the server clamps them, and the value it returns is the one that is true.
   */
  async function create(place, opts) {
    var o = opts || {};
    var sb = client();
    if (!sb) return { ok: false, reason: "offline" };

    try {
      var t = await sb.rpc("loc_share_ticket");
      if (t.error) throw t.error;
      var slip = Array.isArray(t.data) ? t.data[0] : t.data;
      if (!slip || !slip.locator) throw new Error("no ticket");

      var code = window.LocCode.completeCode(slip.locator);
      var body = {
        lat: Number(place.lat), lng: Number(place.lng),
        acc: place.acc == null ? null : Math.round(Number(place.acc)),
        label: String(place.label || "").slice(0, 120),
        at: Date.now(),
        coarse: o.coarseM || null,
      };
      var sealed = await window.LocCode.seal(code, body);
      var rev = await window.LocCode.revokeToken();

      var c = await sb.rpc("loc_share_create", {
        p_ticket: slip.ticket,
        p_handle: sealed.handle,
        p_cipher: sealed.cipher,
        p_iv: sealed.iv,
        p_ttl_minutes: o.ttlMinutes || 30,
        p_max_opens: o.maxOpens || 1,
        p_revoke_hash: rev.hash,
      });
      if (c.error) throw c.error;
      var row = Array.isArray(c.data) ? c.data[0] : c.data;

      var rec = {
        code: code, handle: sealed.handle, revoke: rev.token,
        expiresAt: row && row.expires_at, maxOpens: o.maxOpens || 1,
        label: body.label, at: body.at,
      };
      remember(rec);
      return { ok: true, share: rec };
    } catch (e) {
      try { console.warn("[loc-share] create failed:", e); } catch (_) {}
      return { ok: false, reason: reasonOf(e) };
    }
  }

  // ---- open ------------------------------------------------------------------
  /**
   * Open a code. Resolves with { ok, reason, place, expiresAt, opens, maxOpens }.
   *
   * A malformed code never reaches the network: loc-code.js already knows it is
   * wrong, and spending an attempt on a typo would be unkind as well as useless.
   */
  async function open(codeInput) {
    var problem = window.LocCode.problem(codeInput);
    if (problem) return { ok: false, reason: problem };     // short | long | chars | check

    var sb = client();
    if (!sb) return { ok: false, reason: "offline" };
    var code = window.LocCode.normalize(codeInput);

    try {
      var d = await window.LocCode.derive(code);
      var r = await sb.rpc("loc_share_open", { p_handle: d.handle });
      if (r.error) throw r.error;
      var row = Array.isArray(r.data) ? r.data[0] : r.data;
      if (!row) return { ok: false, reason: "failed" };
      if (row.status !== "ok") return { ok: false, reason: row.status };

      var place = await window.LocCode.open(code, row.cipher, row.iv);
      return {
        ok: true, place: place, expiresAt: row.expires_at,
        opens: row.opens, maxOpens: row.max_opens,
      };
    } catch (e) {
      try { console.warn("[loc-share] open failed:", e); } catch (_) {}
      return { ok: false, reason: reasonOf(e) };
    }
  }

  // ---- the sender's controls -------------------------------------------------
  async function manage(handle, revokeTokenValue, doRevoke) {
    var sb = client();
    if (!sb) return { ok: false, reason: "offline" };
    try {
      var r = await sb.rpc("loc_share_manage", {
        p_handle: handle, p_revoke_token: revokeTokenValue, p_revoke: !!doRevoke,
      });
      if (r.error) throw r.error;
      var row = Array.isArray(r.data) ? r.data[0] : r.data;
      if (!row || row.status !== "ok") return { ok: false, reason: (row && row.status) || "failed" };
      if (doRevoke) forget(handle);
      return { ok: true, row: row };
    } catch (e) {
      return { ok: false, reason: reasonOf(e) };
    }
  }

  window.LocShare = {
    create: create,
    open: open,
    manage: manage,
    mine: mine,
    forget: forget,
    STORE_KEY: STORE_KEY,
  };
})();
