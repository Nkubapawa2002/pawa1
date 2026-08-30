// ============================================================================
//  auth-guard.js — the difference between "signed in" and "has an account".
//
//  Supabase anonymous sign-in gives a guest a REAL session: session.user
//  exists, it has an id, app_uid() resolves, and every `if (session?.user)`
//  written before guests existed answers yes. Three dashboards and two consoles
//  were written before guests existed, so tapping "chat as a guest" and then
//  typing agent-houses.html into the address bar opened the whole listings
//  dashboard: the new-listing form, the tenants table, the demand board, the
//  admin-to-agent inbox. The database still refused every write (RLS fences the
//  catalogues with `not app_is_guest()`), so nothing could be created, but a
//  panel that opens for somebody who can do nothing in it is not a small bug.
//  It is a screen telling a stranger what the inside looks like.
//
//  So there are three states here and never two:
//
//    out       no session at all. Show the sign-in card.
//    guest     an anonymous session. Show the sign-in card AND say plainly
//              why the guest identity cannot go further, because "sign in"
//              is confusing advice to somebody who just did.
//    account   a real, named account. This is the only one that opens a door.
//
//  NOTHING HERE IS A PERMISSION. It decides what to DRAW. The database decides
//  what is allowed, every time, on its own: RLS on owner_user_id for the three
//  catalogues, app_is_guest() for the guest fence, the admins table for the two
//  consoles. If this file were deleted, nothing would become possible that is
//  not already possible; the screens would simply start lying again.
//
//  Public API:  AuthGuard.isGuest(session) · state(session) · gate(opts)
// ============================================================================
(function () {
  "use strict";

  var STYLE_ID = "auth-guard-styles";
  var NOTE_CLASS = "ag-note";

  function t(key, fallback) {
    var got = window.t ? window.t(key) : key;
    return got && got !== key ? got : fallback;
  }

  /** An anonymous Supabase user: a session with nobody behind it. */
  function isGuest(session) {
    return !!(session && session.user && session.user.is_anonymous === true);
  }

  /** "out" · "guest" · "account" — the only three answers this file gives. */
  function state(session) {
    if (!session || !session.user) return "out";
    return isGuest(session) ? "guest" : "account";
  }

  /**
   * Read the state straight from the client, for a page that has no session in
   * hand. Failure is "out": a guard that cannot tell must assume the least.
   */
  async function read(client) {
    var sb = client || window.SB || (window.DataStore && window.DataStore.sb);
    if (!sb) return { session: null, state: "out" };
    try {
      var got = await sb.auth.getSession();
      var session = (got && got.data && got.data.session) || null;
      return { session: session, state: state(session) };
    } catch (_) { return { session: null, state: "out" }; }
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement("style");
    s.id = STYLE_ID;
    // Tokens only. This banner lands on five pages with five different
    // stylesheets, so it may not assume any of them.
    s.textContent =
      "." + NOTE_CLASS + "{display:flex;gap:12px;align-items:flex-start;" +
      "margin:0 0 16px;padding:14px 15px;border-radius:var(--radius-lg,18px);" +
      "border:1px solid color-mix(in srgb,var(--warn) 42%,transparent);" +
      "background:color-mix(in srgb,var(--warn) 10%,transparent);" +
      "font-family:var(--font-ui,system-ui,sans-serif);font-size:13.5px;line-height:1.55;" +
      "color:var(--text,inherit);animation:agIn .34s cubic-bezier(.22,1,.36,1);}" +
      "." + NOTE_CLASS + " svg{flex:0 0 auto;width:20px;height:20px;margin-top:1px;color:var(--warn);}" +
      "." + NOTE_CLASS + " b{display:block;font-weight:800;margin-bottom:3px;color:var(--warn);}" +
      "." + NOTE_CLASS + " .ag-note-tx{min-width:0;}" +
      "." + NOTE_CLASS + " .ag-end{display:inline-block;margin-top:9px;padding:8px 14px;" +
      "min-height:var(--hit-min,44px);box-sizing:border-box;display:inline-flex;align-items:center;" +
      "border-radius:var(--radius-pill,999px);cursor:pointer;font:inherit;font-weight:700;" +
      "border:1px solid color-mix(in srgb,var(--warn) 55%,transparent);" +
      "background:transparent;color:var(--warn);}" +
      "." + NOTE_CLASS + " .ag-end:hover{background:color-mix(in srgb,var(--warn) 16%,transparent);}" +
      "@keyframes agIn{from{opacity:0;transform:translateY(-6px);}}" +
      "@media (prefers-reduced-motion:reduce){." + NOTE_CLASS + "{animation:none;}}";
    document.head.appendChild(s);
  }

  var ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 3l8 3v5c0 5-3.4 8-8 10-4.6-2-8-5-8-10V6z"/><path d="M12 9v4"/><path d="M12 16.2v.1"/></svg>';

  function clearNote(mount) {
    if (!mount) return;
    var old = mount.querySelector("." + NOTE_CLASS);
    if (old) old.remove();
  }

  /**
   * Say it where the person is looking, not in a console. The banner sits at
   * the top of the sign-in card they were just sent to, because otherwise the
   * screen reads "sign in" to somebody who is already signed in, and the only
   * way to work out what went wrong is to guess.
   */
  function paintNote(mount, what) {
    if (!mount) return;
    injectStyles();
    clearNote(mount);
    var box = document.createElement("div");
    box.className = NOTE_CLASS;
    box.setAttribute("role", "status");
    var tx = document.createElement("div");
    tx.className = "ag-note-tx";
    var b = document.createElement("b");
    b.textContent = t("ag_guest_t", "You are here as a guest");
    var p = document.createElement("span");
    p.textContent = what || t("ag_guest_d",
      "A guest session has no account behind it, so it cannot own or manage anything. Sign in with an account, or create one, and this page opens.");
    tx.appendChild(b);
    tx.appendChild(p);

    var end = document.createElement("button");
    end.type = "button";
    end.className = "ag-end";
    end.textContent = t("ag_guest_end", "End the guest session");
    end.addEventListener("click", async function () {
      end.disabled = true;
      try { if (window.Auth) await window.Auth.signOut(); } catch (_) {}
      location.reload();
    });
    tx.appendChild(end);

    box.innerHTML = ICON;
    box.appendChild(tx);
    mount.insertBefore(box, mount.firstChild);
  }

  /**
   * The one call a page makes.
   *
   *   opts.session   a session already in hand, or omitted to read one
   *   opts.mount     where the guest banner goes (the sign-in card)
   *   opts.message   an override for the banner's second line
   *
   * Returns "out" | "guest" | "account". A caller must open its panel only on
   * "account" — the other two are the same instruction with different words.
   */
  async function gate(opts) {
    opts = opts || {};
    var session = opts.session;
    if (session === undefined) session = (await read(opts.client)).session;
    var st = state(session);
    if (st === "guest") paintNote(opts.mount, opts.message);
    else clearNote(opts.mount);
    return st;
  }

  window.AuthGuard = {
    isGuest: isGuest, state: state, read: read,
    gate: gate, paintNote: paintNote, clearNote: clearNote,
  };
})();
