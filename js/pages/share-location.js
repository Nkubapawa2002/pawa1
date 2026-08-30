// ============================================================================
//  share-location.js — one tap, one exact spot.
//
//  THREE WAYS IN, and they are not the same job:
//
//  1. AGENT MODE  (?c=<meet room code>)
//     The agent sends this link to whoever is standing at the property. One
//     button captures the device GPS and writes it to live_locations for that
//     room; the agent's listing form is subscribed to the same room and drops
//     the pin instantly. No login. Reuses the public meet_rooms /
//     live_locations tables. The tab bar is hidden here on purpose: the person
//     was sent to do exactly one thing, and a choice would only confuse.
//
//  2. SEND  (no code — how P-Chat opens it)
//     Capture where you are, then give it away in whichever of two shapes the
//     other person can actually receive:
//
//       · a LINK, for anyone with a smartphone and the message in front of
//         them. Nothing is stored; the link is yours to send.
//       · nine CHARACTERS, for the phone call — which is the common case in
//         practice, and the one a link cannot serve. "K7M-2Q9-F3T" is read
//         aloud, the other person types it, the pin drops on their map. The
//         coordinates are encrypted under the code IN THIS BROWSER before
//         anything is uploaded, so the server holds ciphertext and never the
//         code (see supabase/features/location/loc_share.sql).
//
//  3. RECEIVE  (no code, second tab)
//     The other end of that phone call. Type the nine characters, see the
//     place, and keep it: js/lib/place-book.js remembers it on this device so
//     the agent's listing form can pin from it later without a second call.
//
//  Location goes through pawaLocate (js/lib/geolocate.js) rather than raw
//  navigator.geolocation, because it already knows how to wait for a real fix
//  and how to explain a refusal in words a person can act on.
// ============================================================================
(function () {
  "use strict";

  const params = new URLSearchParams(location.search);
  const code = (params.get("c") || "").trim().toUpperCase();
  const C = window.APP_CONFIG || {};
  const sb = (window.supabase && C.SUPABASE_URL && C.SUPABASE_ANON_KEY)
    ? window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY)
    : null;

  // A missing key falls through to the English written here rather than
  // printing its own name at somebody — this page is read by people who were
  // sent a link and have no idea what "sl_code_made" is meant to mean.
  const T = (k, fallback) => {
    const v = window.t ? window.t(k) : k;
    return (!v || v === k) ? (fallback == null ? k : fallback) : v;
  };
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s)
    .replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const statusEl = $("slStatus");
  const btn = $("slBtn");
  const titleEl = $("slTitle");
  const leadEl = $("slLead");
  const resultEl = $("slResult");

  // A fix, however we got it: { lat, lng, accuracy } from pawaLocate, falling
  // back to the raw API if the library is not on the page.
  async function locate() {
    if (window.pawaLocate && window.pawaLocate.supported()) {
      return window.pawaLocate.best({ maxWaitMs: 20000 });
    }
    if (!navigator.geolocation) throw new Error(T("sl_no_gps"));
    return new Promise((res, rej) => {
      navigator.geolocation.getCurrentPosition(
        (p) => res({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
        rej,
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
    });
  }

  function explain(e) {
    if (window.pawaLocate && window.pawaLocate.message) return window.pawaLocate.message(e);
    return (e && e.message) || T("sl_fail");
  }

  // ------------------------------------------------------------------ the map
  // One helper for both tabs. Leaflet only — this page has no MapLibre and does
  // not need one: a single marker on a street map is the whole requirement.
  const maps = {};
  function showMap(id, lat, lng, accuracy) {
    const box = $(id);
    if (!box || !window.L) return;
    box.hidden = false;
    if (!maps[id]) {
      maps[id] = window.L.map(box, { attributionControl: false, zoomControl: false })
        .setView([lat, lng], 17);
      // Through the shared chain like every other map, rather than straight at
      // tile.openstreetmap.org, whose usage policy asks applications not to
      // use it and whose tiles carry no imagery at all. This is the map that
      // shows somebody exactly where they are standing, so aerial context is
      // the whole point of it.
      // control:false because this map is a 200px confirmation thumbnail, with
      // no room for Leaflet's layer switcher. The base is added either way.
      if (window.addSatelliteHybrid) window.addSatelliteHybrid(maps[id], { control: false });
      else window.L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(maps[id]);
      maps[id].__marker = window.L.marker([lat, lng]).addTo(maps[id]);
    } else {
      maps[id].setView([lat, lng], 17);
      maps[id].__marker.setLatLng([lat, lng]);
    }
    if (maps[id].__circle) { maps[id].removeLayer(maps[id].__circle); maps[id].__circle = null; }
    if (accuracy > 0) {
      maps[id].__circle = window.L.circle([lat, lng], {
        radius: accuracy, color: "#2EE6A6", weight: 1, fillOpacity: 0.10,
      }).addTo(maps[id]);
    }
    // The container was hidden when Leaflet measured it, so it thinks it is
    // zero-sized until told otherwise.
    setTimeout(() => maps[id].invalidateSize(), 60);
  }

  function mapsUrl(lat, lng) {
    return "https://www.google.com/maps/search/?api=1&query=" +
      Number(lat).toFixed(6) + "," + Number(lng).toFixed(6);
  }

  /**
   * Web Share, then the clipboard, then a prompt to copy out of.
   *
   * The same ladder js/pages/house.js uses and for the same reason: the
   * clipboard API fails on http:// and inside some in-app browsers, and a
   * "Copy" button that silently does nothing is worse than no button.
   */
  async function handOver(text, url, title) {
    if (navigator.share) {
      try { await navigator.share({ title: title, text: text, url: url }); return "shared"; }
      catch (_) { return "cancelled"; }
    }
    try { await navigator.clipboard.writeText(text); return "copied"; } catch (_) {}
    try { window.prompt(T("sl_copy_manual"), url || text); } catch (_) {}
    return "manual";
  }

  // ---------------------------------------------------------------- send mode
  // The place this tab is currently holding, or null. Both ways out read it,
  // so it lives here rather than being closed over by whichever handler was
  // built last.
  let captured = null;

  function startShareMode() {
    if (titleEl) titleEl.textContent = T("sl_share_title");
    if (leadEl) leadEl.innerHTML = T("sl_share_lead");
    btn.textContent = T("sl_share_btn");

    // The two ways out are markup now, not something renderCaptured() builds,
    // so they are wired ONCE. They were being rebuilt and rebound on every
    // capture, which is how the code half came to exist only after a GPS fix.
    const ways = $("slWays");
    if (ways) { ways.hidden = false; ways.classList.add("is-waiting"); }
    setWaysEnabled(false);

    btn.addEventListener("click", async () => {
      btn.disabled = true;
      statusEl.textContent = T("sl_getting");
      try {
        const fix = await locate();
        renderCaptured(fix);
      } catch (e) {
        statusEl.textContent = explain(e);
        btn.disabled = false;
      }
    });

    $("slSendLink").addEventListener("click", async () => {
      if (!captured) return;
      const url = mapsUrl(captured.lat, captured.lng);
      const how = await handOver(T("sl_share_text") + "\n" + url, url, T("sl_share_title"));
      if (how === "copied") statusEl.textContent = T("sl_copied");
    });

    $("slMake").addEventListener("click", () => { if (captured) mintCode(captured); });

    $("slAgain").addEventListener("click", () => {
      captured = null;
      resultEl.hidden = true; resultEl.innerHTML = "";
      statusEl.textContent = "";
      const box = $("slMapSend"); if (box) box.hidden = true;
      const out = $("slCodeOut"); if (out) { out.className = "sl-msg"; out.innerHTML = ""; }
      const make = $("slMake"); if (make) make.textContent = T("sl_code_make", "Make a code");
      const hint = $("slWaysHint"); if (hint) hint.hidden = false;
      const w = $("slWays"); if (w) w.classList.add("is-waiting");
      const open = $("slOpen"); if (open) open.hidden = true;
      setWaysEnabled(false);
      $("slAgain").hidden = true;
      btn.style.display = "";
      btn.disabled = false;
    });

    renderMine();
  }

  /** Both ways out are usable exactly when there is a place to hand over. */
  function setWaysEnabled(on) {
    const link = $("slSendLink"), make = $("slMake");
    if (link) link.disabled = !on;
    if (make) make.disabled = !on;
  }

  /**
   * What you can do with a place you have just captured.
   *
   * Both shapes are offered side by side rather than one behind the other,
   * because which one is right depends entirely on how the other person is
   * reachable — and only the sender knows that.
   */
  function renderCaptured(fix) {
    const lat = Number(fix.lat), lng = Number(fix.lng);
    const url = mapsUrl(lat, lng);
    const acc = fix.accuracy ? T("sl_accuracy").replace("{m}", Math.round(fix.accuracy)) : "";

    statusEl.textContent = "";
    btn.style.display = "none";
    showMap("slMapSend", lat, lng, fix.accuracy);

    // What was captured. The two ways out are already on screen, so this fills
    // in the readout and switches them on rather than building them: a control
    // that only exists after a permission prompt succeeds is a control most
    // people never learn about.
    captured = { lat: lat, lng: lng, accuracy: fix.accuracy || null };

    resultEl.hidden = false;
    resultEl.innerHTML =
      '<div class="sl-coords">' + esc(Number(lat).toFixed(6)) + ", " + esc(Number(lng).toFixed(6)) + "</div>" +
      '<div class="sl-acc">' + esc(acc) + "</div>";

    const open = $("slOpen");
    if (open) { open.href = url; open.hidden = false; }
    const hint = $("slWaysHint");
    if (hint) hint.hidden = true;
    const ways = $("slWays");
    if (ways) { ways.hidden = false; ways.classList.remove("is-waiting"); }
    setWaysEnabled(true);
    $("slAgain").hidden = false;
  }

  /** Every reason a mint can fail, as the ordinary thing it is. */
  function mintReason(reason) {
    return {
      signin: T("sl_r_signin", "Sign in first — making a code needs an account."),
      offline: T("sl_r_offline", "No connection. Try again when you're back online."),
      busy: T("sl_r_busy", "Too many codes at once. Wait a moment and try again."),
      exhausted: T("sl_r_exhausted", "Codes are temporarily unavailable. Send the link instead."),
      ticket: T("sl_r_ticket", "That attempt timed out. Tap “Make a code” again."),
    }[reason] || T("sl_r_failed", "Couldn't make a code. Send the link instead.");
  }

  async function mintCode(fix) {
    const out = $("slCodeOut");
    const make = $("slMake");
    if (!window.LocShare) { out.textContent = T("sl_unavailable"); return; }
    make.disabled = true;
    out.className = "sl-msg";
    out.textContent = T("sl_code_making", "Making a code…");

    const coarseM = $("slCoarse").checked ? 100 : null;
    // Rounding happens HERE, before the coordinates are sealed — a "coarse"
    // flag the reader is trusted to honour would not be coarse at all.
    let lat = Number(fix.lat), lng = Number(fix.lng), acc = fix.accuracy || null;
    if (coarseM && window.LocCode && window.LocCode.coarsen) {
      const c = window.LocCode.coarsen(lat, lng, coarseM);
      lat = c.lat; lng = c.lng;
      acc = Math.max(acc || 0, coarseM);
    }

    const res = await window.LocShare.create(
      { lat: lat, lng: lng, acc: acc, label: "" },
      { ttlMinutes: Number($("slTtl").value) || 120,
        maxOpens: Number($("slOpens").value) || 1,
        coarseM: coarseM });

    make.disabled = false;
    if (!res.ok) {
      // is-bad, not bad: the stylesheet only ever defined .sl-msg.is-bad,
      // so every failure on this page was being painted in the SUCCESS mint.
      out.className = "sl-msg is-bad";
      out.textContent = mintReason(res.reason);
      return;
    }

    const pretty = window.LocCode.format(res.share.code);
    // A code now exists, so the button that made it must stop saying the thing
    // it already did. Left alone it reads as "this did not work, press again",
    // which is how somebody ends up with three live codes for one doorstep.
    make.textContent = T("sl_code_again", "Make another code");
    out.className = "sl-msg";
    out.innerHTML =
      `<div class="sl-code">${esc(pretty)}</div>` +
      `<p class="sl-code-note">${esc(T("sl_code_say", "Read these nine characters to them. O is the number zero; I and L are the number one."))}</p>` +
      `<div class="sl-actions"><button id="slCodeCopy" class="sl-act sl-act-primary" type="button">${esc(T("sl_code_copy", "Send the code"))}</button></div>`;

    $("slCodeCopy").addEventListener("click", async () => {
      const how = await handOver(
        T("sl_code_msg", "My location code is {c} — open it at {u}")
          .replace("{c}", pretty)
          .replace("{u}", location.origin + location.pathname),
        null, T("sl_share_title"));
      if (how === "copied") statusEl.textContent = T("sl_copied");
    });

    renderMine();
  }

  // ---- the codes this device gave out ---------------------------------------
  // Kept by js/lib/loc-share.js in localStorage, because without them "here is
  // the code you made ten minutes ago" is impossible and the alternative is
  // people minting a second share because they lost the first.
  function renderMine() {
    const wrap = $("slMine"), list = $("slMineList");
    if (!wrap || !list || !window.LocShare) return;
    const rows = window.LocShare.mine();
    if (!rows.length) { wrap.hidden = true; list.innerHTML = ""; return; }
    wrap.hidden = false;
    list.innerHTML = "";
    rows.forEach((r) => {
      const row = document.createElement("div");
      row.className = "sl-mine-row";
      const mins = Math.max(0, Math.round((new Date(r.expiresAt).getTime() - Date.now()) / 60000));
      const left = mins >= 60
        ? T("sl_mine_hours", "{n} h left").replace("{n}", Math.round(mins / 60))
        : T("sl_mine_mins", "{n} min left").replace("{n}", mins);
      row.innerHTML =
        `<span class="sl-mine-code">${esc(window.LocCode.format(r.code))}</span>` +
        `<span class="sl-mine-when">${esc(left)}</span>` +
        `<button type="button" class="sl-mine-kill">${esc(T("sl_mine_kill", "Cancel"))}</button>`;
      row.querySelector(".sl-mine-kill").addEventListener("click", async () => {
        const kill = row.querySelector(".sl-mine-kill");
        kill.disabled = true;
        const done = await window.LocShare.manage(r.handle, r.revoke, true);
        // A code the server has already forgotten is a code that cannot be
        // used, which is what the person asked for — so drop it from the list
        // either way rather than leaving a row that refuses to go.
        if (!done.ok && done.reason !== "not_found") { kill.disabled = false; return; }
        window.LocShare.forget(r.handle);
        renderMine();
      });
      list.appendChild(row);
    });
  }

  // ------------------------------------------------------------- receive mode
  function startReceiveMode() {
    const input = $("slCodeInput"), go = $("slRecvGo"), msg = $("slRecvMsg"), out = $("slRecvOut");
    if (!input) return;

    // The person on the other end is reading it in threes, so the box agrees.
    input.addEventListener("input", () => {
      if (!window.LocCode) return;
      const c = window.LocCode.normalize(input.value);
      const atEnd = input.selectionStart === input.value.length;
      input.value = c.length === window.LocCode.CODE_LEN
        ? window.LocCode.format(c)
        : c.replace(/(.{3})(?=.)/g, "$1-");
      if (atEnd) input.setSelectionRange(input.value.length, input.value.length);
      go.disabled = !!window.LocCode.problem(input.value);
      msg.textContent = "";
      msg.className = "sl-msg";
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !go.disabled) { e.preventDefault(); go.click(); }
    });

    go.addEventListener("click", async () => {
      if (!window.LocShare) { msg.textContent = T("sl_unavailable"); return; }
      go.disabled = true;
      msg.className = "sl-msg";
      msg.textContent = T("sl_recv_opening", "Opening…");
      const r = await window.LocShare.open(input.value);
      go.disabled = false;
      if (!r.ok) {
        msg.className = "sl-msg is-bad";
        msg.textContent = openReason(r.reason);
        return;
      }
      msg.textContent = "";
      showPlace(r);
    });

    function showPlace(r) {
      const lat = Number(r.place.lat), lng = Number(r.place.lng);
      showMap("slMapRecv", lat, lng, r.place.acc);
      const url = mapsUrl(lat, lng);
      const acc = r.place.acc ? T("sl_accuracy").replace("{m}", Math.round(r.place.acc)) : "";
      out.hidden = false;
      out.innerHTML = `
        <div class="sl-coords">${esc(Number(lat).toFixed(6))}, ${esc(Number(lng).toFixed(6))}</div>
        <div class="sl-acc">${esc(acc)}</div>
        <div class="sl-actions">
          <a class="sl-act sl-act-primary" href="${esc(url)}" target="_blank" rel="noopener">${esc(T("sl_open_maps"))}</a>
        </div>
        <p class="sl-code-note" id="slKept"></p>`;

      // Kept on THIS DEVICE, so the agent's listing form can pin from it later
      // without a second phone call. Nothing is uploaded — see
      // js/lib/place-book.js on why that matters here in particular.
      if (window.PlaceBook) {
        window.PlaceBook.add({
          lat: lat, lng: lng, acc: r.place.acc || null,
          label: r.place.label || "", source: "code",
          from: window.LocCode.format(window.LocCode.normalize(input.value)),
        });
        $("slKept").textContent = T("sl_recv_kept",
          "Saved on this phone. When you add a listing, this spot is one tap away in the pin box.");
      }
    }
  }

  function openReason(reason) {
    return {
      short: T("sl_r_short", "Too short — a code has nine characters."),
      long: T("sl_r_long", "Too long — a code has nine characters."),
      chars: T("sl_r_chars", "There's a character in there that can't be right. O is zero; I and L are one."),
      check: T("sl_r_check", "That isn't quite right — one character is off. Ask them to read it again."),
      expired: T("sl_r_expired", "That code has expired. Ask for a new one."),
      used_up: T("sl_r_used", "That code has already been used its full number of times."),
      revoked: T("sl_r_revoked", "The person who made it cancelled it."),
      not_found: T("sl_r_notfound", "No place under that code. Check the characters."),
      rate_limited: T("sl_r_rate", "Too many tries. Wait a minute, then try again."),
      signin: T("sl_r_signin_open", "Sign in first. Opening a code needs an account."),
      // The one that had no sentence, so it fell through to "try again in a
      // moment" — advice about something that could never work. The database
      // answers 'forbidden' when the account opening the code is not one it
      // will meter, and no amount of retrying changes that.
      forbidden: T("sl_r_forbidden", "This device is browsing as a guest, and a code needs an account. Sign in, then type it again."),
      offline: T("sl_r_offline", "No connection. Try again when you're back online."),
    }[reason] || T("sl_r_failed_open", "Couldn't open that code. Try again in a moment.");
  }

  // ---------------------------------------------------------------- agent mode
  function startAgentMode() {
    if (!sb) { statusEl.textContent = T("sl_unavailable"); btn.disabled = true; return; }

    btn.addEventListener("click", async () => {
      btn.disabled = true;
      statusEl.textContent = T("sl_getting");
      try {
        const fix = await locate();
        const { error } = await sb.from("live_locations").insert({
          room_code: code,
          user_id: "onsite-" + Math.random().toString(36).slice(2, 8),
          display_name: "At the house",
          role: "onsite",
          lat: fix.lat, lng: fix.lng, accuracy_m: fix.accuracy || null,
        });
        if (error) throw error;
        statusEl.innerHTML = T("sl_sent");
        showMap("slMapSend", fix.lat, fix.lng, fix.accuracy);
        btn.style.display = "none";
      } catch (e) {
        // A geolocation refusal and a database failure are different problems
        // and deserve different sentences.
        statusEl.textContent = (e && (e.code === 1 || e.code === 2 || e.code === 3))
          ? explain(e)
          : T("sl_send_fail");
        try { console.error("[share-location] send failed:", e); } catch (_) {}
        btn.disabled = false;
      }
    });
  }

  // ------------------------------------------------------------------- routing
  function showTab(which) {
    const send = which === "send";
    $("slSend").hidden = !send;
    $("slRecv").hidden = send;
    $("slTabSend").classList.toggle("is-on", send);
    $("slTabRecv").classList.toggle("is-on", !send);
    $("slTabSend").setAttribute("aria-selected", String(send));
    $("slTabRecv").setAttribute("aria-selected", String(!send));
  }

  if (code) {
    startAgentMode();
  } else {
    const tabs = $("slTabs"), fine = $("slFine");
    if (tabs) tabs.hidden = false;
    if (fine) fine.hidden = false;
    $("slTabSend").addEventListener("click", () => showTab("send"));
    $("slTabRecv").addEventListener("click", () => showTab("recv"));
    startShareMode();
    startReceiveMode();
    // ?recv=1, or arriving with a code in the query, lands on the tab that
    // matters — a link that says "open this code" should not need a tap first.
    const pre = (params.get("code") || "").trim();
    if (pre || params.get("recv")) {
      showTab("recv");
      if (pre && $("slCodeInput")) {
        $("slCodeInput").value = pre;
        $("slCodeInput").dispatchEvent(new Event("input"));
      }
    }
  }
})();
