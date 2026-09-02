// ============================================================================
//  login.js — one door into the whole app.
//
//  Three ways in, on one card:
//    · Password       — email + password, the ordinary way.
//    · Email code     — a six-digit code, for the (many) people who have no
//                       idea what password they used and never will.
//    · Create account — with a strength meter that says what is missing rather
//                       than just colouring a bar red.
//  Plus: forgot-password, the reset-link landing, a guest door, and the portal
//  chooser that routes an account to whatever it actually owns.
//
//  Two rules run through all of it:
//
//  1. NOTHING RAW REACHES THE SCREEN. Every failure goes through
//     AuthErrors.message(). A provider error string is a description of our
//     infrastructure — which database, which auth server, which table, which
//     policy failed — and a sign-in box is the last place to publish it. The
//     only strings this file renders are ones we wrote.
//
//  2. THE PAGE SLOWS DOWN BEFORE THE SERVER HAS TO. AuthPolicy's throttle
//     locks a repeatedly-failing address out locally, with a countdown, so an
//     honest person sees words instead of collecting a silent provider block.
// ============================================================================

window.initLoginPage = () => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const A = window.Auth || {};
  const E = window.AuthErrors;
  const P = window.AuthPolicy;
  const T = (key, en) => {
    const got = window.t ? window.t(key) : key;
    return got && got !== key ? got : en;
  };
  const store = (() => {
    try { localStorage.setItem("__t", "1"); localStorage.removeItem("__t"); return localStorage; }
    catch (_) { return null; }
  })();

  const REMEMBER_KEY = "pawa-last-email";
  const RESEND_COOLDOWN_S = 45;

  // ---- icons ---------------------------------------------------------------
  const svg = (paths, w) =>
    `<svg viewBox="0 0 24 24" ${w ? `width="${w}" height="${w}" ` : ""}fill="none" stroke="currentColor" ` +
    `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const ICON = {
    admin: svg('<path d="M12 3l8 3v5c0 5-3.4 8-8 10-4.6-2-8-5-8-10V6z"/><path d="m9 12 2 2 4-4"/>'),
    houses: svg('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9.5 21v-6h5v6"/>'),
    trucks: svg('<path d="M1 6h13v9H1z"/><path d="M14 9h4l3 3v3h-7z"/><circle cx="5.5" cy="18" r="1.7"/><circle cx="17.5" cy="18" r="1.7"/>'),
    services: svg('<path d="M14.7 6.3a4 4 0 0 0-5.4 5.3L3 18l3 3 6.4-6.3a4 4 0 0 0 5.3-5.4l-2.9 2.9-2.1-2.1z"/>'),
    go: svg('<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>'),
    err: svg('<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.2v.1"/>'),
    ok: svg('<circle cx="12" cy="12" r="9"/><path d="m8.5 12.2 2.4 2.4 4.6-4.9"/>'),
    info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.8v.1"/>'),
  };

  // ---- status lines --------------------------------------------------------
  // kind: "error" | "ok" | "info" | "warn" | "" (clear)
  function say(el, kind, text) {
    const node = typeof el === "string" ? $(el) : el;
    if (!node) return;
    const safe = E ? E.redact(text) : String(text || "");
    if (!kind || !safe) { node.className = "lg-msg"; node.innerHTML = ""; return; }
    const ic = kind === "error" ? ICON.err : kind === "ok" ? ICON.ok : ICON.info;
    node.className = "lg-msg is-show is-" + kind;
    node.innerHTML = `<span class="lg-msg-ic">${ic}</span><span></span>`;
    node.lastElementChild.textContent = safe;     // textContent: never parse our own copy
  }

  // A hint under one field, tied to it by aria so a screen reader hears it.
  function hint(inputId, hintId, kind, text) {
    const input = $(inputId), node = $(hintId);
    if (node) {
      node.hidden = !text;
      node.textContent = text ? (E ? E.redact(text) : text) : "";
      node.className = "lg-hint" + (kind ? " is-" + kind : "");
    }
    if (input) {
      if (kind === "error" && text) input.setAttribute("aria-invalid", "true");
      else input.removeAttribute("aria-invalid");
    }
  }

  // ---- button busy state ---------------------------------------------------
  function busy(btn, on, label) {
    if (!btn) return;
    if (on) {
      if (!btn.dataset.idle) btn.dataset.idle = btn.textContent;
      btn.disabled = true;
      btn.innerHTML = `<span class="lg-spinner"></span><span></span>`;
      btn.lastElementChild.textContent = label || T("lg_working", "Working…");
    } else {
      btn.disabled = false;
      btn.textContent = btn.dataset.idle || btn.textContent;
    }
  }

  // ---- cards ---------------------------------------------------------------
  const CARDS = ["stepDoor", "cardAuth", "cardSent", "cardRecovery", "cardPortal"];

  /**
   * The rail: two questions, and which one you are standing in.
   *
   * It is driven off whichever card is open rather than off a counter, so it
   * cannot fall out of step with the screen. Anything past the account card
   * (the inbox notice, the reset landing, the portal) is the end of the walk,
   * so both steps read as done rather than as a third one nobody was told about.
   */
  function paintRail(id) {
    const rail = $("lgRail");
    if (!rail) return;
    const items = [...rail.querySelectorAll("li")];
    const at = items.findIndex((li) => li.dataset.step === id);
    items.forEach((li, i) => {
      const done = at < 0 ? true : i < at;
      const on = at >= 0 && i === at;
      li.classList.toggle("is-done", done);
      li.classList.toggle("is-on", on);
      if (on) li.setAttribute("aria-current", "step");
      else li.removeAttribute("aria-current");
    });
  }

  function show(id) {
    CARDS.forEach((c) => { const el = $(c); if (el) el.hidden = c !== id; });
    paintRail(id);
    try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch (_) {}
  }

  // ---- the four doors ------------------------------------------------------
  // A door decides where somebody lands and how the page talks to them. It
  // grants nothing: see the header of js/lib/login-doors.js for why that
  // distinction is load-bearing and must not be softened.
  const D = window.LoginDoors;

  /** Move between the door step and the card, as a move rather than a swap. */
  function goStep(id) {
    const from = CARDS.map($).find((el) => el && !el.hidden);
    const to = $(id);
    if (!to) return;
    const reduced = window.matchMedia
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!from || from === to || reduced) { show(id); return; }
    from.classList.add("is-leaving");
    // Let the leaving card finish before the arriving one starts, or the two
    // overlap and the eye reads a flicker instead of a transition.
    setTimeout(() => {
      from.classList.remove("is-leaving");
      show(id);
      to.classList.add("is-entering");
      setTimeout(() => to.classList.remove("is-entering"), 460);
    }, 190);
  }

  /** Restate the chosen door above the form, and make it reversible. */
  function paintChosen(key) {
    const chip = $("chosenDoor");
    const m = D && D.meta(key);
    if (!chip || !m) { if (chip) chip.hidden = true; return; }
    chip.hidden = false;
    chip.style.setProperty("--d", m.accent);
    // The card takes the door's colour, so what you chose is still visible
    // while you fill in the thing it led to.
    D.paint(key);
    $("chosenIc").innerHTML = m.icon;
    $("chosenName").textContent = T(m.name[0], m.name[1]);
    $("chosenWhat").textContent = T(m.what[0], m.what[1]);
  }

  if (D) {
    D.init({
      grid: $("doorGrid"),
      onPick: (key) => { paintChosen(key); goStep("cardAuth"); },
    });
    $("chosenDoor")?.addEventListener("click", () => goStep("stepDoor"));
  }

  // ---- method tabs ---------------------------------------------------------
  const PANES = { password: "panePassword", code: "paneCode", signup: "paneSignup" };
  const TITLES = {
    password: ["lg_title_signin", "Sign in", "lg_sub_signin", "Welcome back. We'll take you straight to whatever is yours."],
    code: ["lg_title_code", "Sign in with a code", "lg_sub_code", "No password to remember. We email you six digits that work once."],
    signup: ["lg_title_signup", "Create your account", "lg_sub_signup", "One account covers houses, services and trucks, and your encrypted messages."],
  };
  let method = "password";

  function setMethod(m) {
    if (!PANES[m]) return;
    method = m;
    Object.keys(PANES).forEach((k) => {
      const pane = $(PANES[k]);
      if (pane) pane.hidden = k !== m;
      const tab = document.querySelector(`.lg-tab[data-method="${k}"]`);
      if (tab) tab.setAttribute("aria-selected", String(k === m));
    });
    // The pill under the tabs slides to the chosen one. Index, not pixels: the
    // three tabs are an equal-width grid, so a fraction of the track is the
    // whole answer and nothing has to be measured or re-measured on resize.
    const tabs = document.querySelector(".lg-tabs");
    if (tabs) tabs.style.setProperty("--i", String(Object.keys(PANES).indexOf(m)));
    const [tk, te, sk, se] = TITLES[m];
    $("authTitle").textContent = T(tk, te);
    $("authSub").textContent = T(sk, se);
    say("authMsg", "", "");
    // Move focus to the first empty field of the pane the person just chose.
    const first = $(PANES[m]).querySelector("input:not([type=checkbox])");
    if (first && !first.value) setTimeout(() => first.focus(), 30);
  }

  document.querySelectorAll(".lg-tab").forEach((tab) => {
    tab.addEventListener("click", () => setMethod(tab.dataset.method));
    // Arrow keys move between tabs, the way a tablist is supposed to.
    tab.addEventListener("keydown", (e) => {
      const order = ["password", "code", "signup"];
      const i = order.indexOf(tab.dataset.method);
      let next = -1;
      if (e.key === "ArrowRight") next = (i + 1) % order.length;
      if (e.key === "ArrowLeft") next = (i + order.length - 1) % order.length;
      if (next < 0) return;
      e.preventDefault();
      setMethod(order[next]);
      document.querySelector(`.lg-tab[data-method="${order[next]}"]`).focus();
    });
  });

  document.querySelectorAll("[data-back]").forEach((b) => {
    b.addEventListener("click", () => { show("cardAuth"); setMethod("password"); });
  });

  // ---- show/hide password + caps lock -------------------------------------
  document.querySelectorAll(".lg-eye").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = $(btn.dataset.eye);
      if (!input) return;
      const reveal = input.type === "password";
      input.type = reveal ? "text" : "password";
      btn.setAttribute("aria-pressed", String(reveal));
      btn.setAttribute("aria-label", reveal ? T("lg_hide_pw", "Hide password") : T("lg_show_pw", "Show password"));
      input.focus();
    });
  });

  // Caps Lock silently turning a correct password into a wrong one is one of
  // the most common causes of "the login is broken".
  function watchCaps(inputId, hintId) {
    const input = $(inputId);
    if (!input) return;
    const check = (e) => {
      const on = e.getModifierState && e.getModifierState("CapsLock");
      const node = $(hintId);
      if (!node) return;
      if (on) hint(inputId, hintId, "warn", T("lg_caps", "Caps Lock is on."));
      else if (node.classList.contains("is-warn")) hint(inputId, hintId, "", "");
    };
    input.addEventListener("keyup", check);
    input.addEventListener("keydown", check);
    input.addEventListener("blur", () => {
      const node = $(hintId);
      if (node && node.classList.contains("is-warn")) hint(inputId, hintId, "", "");
    });
  }
  watchCaps("pwPassword", "pwPassHint");

  // ---- the local lockout ---------------------------------------------------
  let tick = null;
  function stopTick() { if (tick) { clearInterval(tick); tick = null; } }

  function lockUI(seconds, btn, msgEl) {
    stopTick();
    let left = seconds;
    const paint = () => {
      if (left <= 0) {
        stopTick();
        if (btn) busy(btn, false);
        say(msgEl, "", "");
        return;
      }
      if (btn) { btn.disabled = true; }
      say(msgEl, "warn", T("lg_locked", "Too many tries. Wait {s} seconds and try again.")
        .replace("{s}", String(left)));
      left--;
    };
    paint();
    tick = setInterval(paint, 1000);
  }

  function throttleCheck(email, btn, msgEl) {
    if (!P || !store) return true;
    const st = P.attemptState(store, email);
    if (st.locked) { lockUI(st.secondsLeft, btn, msgEl); return false; }
    return true;
  }

  // ---- safe post-sign-in redirect -----------------------------------------
  // Only a same-origin RELATIVE path is honoured. An absolute URL, or a
  // protocol-relative "//evil.com", would turn this into an open redirect.
  function nextTarget() {
    const raw = new URLSearchParams(location.search).get("next") || "";
    if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//")) return "";
    return /^[\w./-]+\.html(\?[\w=&%.-]*)?(#[\w-]*)?$/.test(raw) ? raw : "";
  }

  // ---- portal detection ----------------------------------------------------
  const PORTALS = [
    { key: "admin", href: "admin.html", icon: ICON.admin,
      label: ["lg_p_admin", "System admin"], sub: ["lg_p_admin_d", "Agents, listings, tenants, day jobs"] },
    { key: "houses", href: "agent-houses.html", icon: ICON.houses,
      label: ["lg_p_houses", "Houses portal"], sub: ["lg_p_houses_d", "Your property listings & tenants"] },
    { key: "trucks", href: "agent-trucks.html", icon: ICON.trucks,
      label: ["lg_p_trucks", "Trucks portal"], sub: ["lg_p_trucks_d", "Your moving-truck listings"] },
    { key: "services", href: "agent-services.html", icon: ICON.services,
      label: ["lg_p_services", "Services portal"], sub: ["lg_p_services_d", "Your daily-services listings"] },
  ];

  async function detectPortals(session) {
    const sb = window.SB || (window.DataStore && window.DataStore.sb);
    const uid = session.user.id;
    const email = session.user.email || "";
    const found = new Set();
    if (A.isAllowedEmail && A.isAllowedEmail(email)) found.add("admin");
    if (!sb) return PORTALS.filter((p) => found.has(p.key));
    // Every probe is independent and failure-tolerant: a denial simply means
    // "not linked to that portal", never an error on screen.
    const probe = async (q, key) => {
      try {
        const { data, error } = await q;
        if (error) return;
        if (Array.isArray(data) ? data.length > 0 : !!data) found.add(key);
      } catch (_) {}
    };
    await Promise.all([
      probe(sb.from("houses").select("id").eq("owner_user_id", uid).limit(1), "houses"),
      probe(sb.from("trucks").select("id").eq("owner_user_id", uid).limit(1), "trucks"),
      probe(sb.from("services").select("id").eq("owner_user_id", uid).limit(1), "services"),
    ]);
    return PORTALS.filter((p) => found.has(p.key));
  }

  function renderPortals(session, mine) {
    const list = $("portalList");
    const empty = $("portalEmpty");
    $("portalSpinner").hidden = true;
    list.innerHTML = "";

    const isGuest = session.user && session.user.is_anonymous === true;
    const shown = mine.length ? mine : PORTALS;

    if (isGuest) {
      empty.hidden = false;
      say(empty, "warn", T("lg_portal_guest",
        "You're browsing as a guest, so nothing is linked to you yet. Create an account to keep your listings and messages."));
    } else if (!mine.length) {
      empty.hidden = false;
      say(empty, "info", T("lg_portal_none",
        "This account isn't linked to a portal yet. If you just registered, open the portal you signed up in. Otherwise pick where you want to go."));
    } else {
      empty.hidden = true;
      say(empty, "", "");
    }

    // Always offer the ordinary way back into the app, first.
    const home = document.createElement("a");
    home.className = "lg-route";
    home.href = "index.html";
    home.innerHTML = `<span class="lg-route-ic">${ICON.houses}</span>` +
      `<span class="lg-route-tx"><span></span><small></small></span>` +
      `<span class="lg-route-go">${ICON.go}</span>`;
    home.querySelector("span > span").textContent = T("lg_p_browse", "Browse the app");
    home.querySelector("small").textContent = T("lg_p_browse_d", "Houses, services and trucks near you");
    list.appendChild(home);

    for (const p of shown) {
      const a = document.createElement("a");
      a.className = "lg-route";
      a.href = p.href;
      a.innerHTML = `<span class="lg-route-ic">${p.icon}</span>` +
        `<span class="lg-route-tx"><span></span><small></small></span>` +
        `<span class="lg-route-go">${ICON.go}</span>`;
      a.querySelector("span > span").textContent = T(p.label[0], p.label[1]);
      a.querySelector("small").textContent = T(p.sub[0], p.sub[1]);
      list.appendChild(a);
    }
  }

  async function routeSignedIn(session, { autoRedirect } = {}) {
    if (!session) return;
    if (autoRedirect) {
      // An explicit destination beats the portal chooser: this person did not
      // come here to pick a portal, they came to finish something else.
      const next = nextTarget();
      if (next) { location.href = next; return; }
    }
    // The account's own answer outranks the door somebody just tapped: a
    // landlord who mis-taps "Agent" has mis-tapped, not been promoted.
    const said = D ? await D.fromAccount() : null;
    if (said && D) D.set(said);
    const type = said || (D && D.get());

    // Record the OWNER door on the server, once, at the first sign-in that
    // knows about it. The door itself is user metadata, which the account can
    // rewrite, so it cannot be the thing that decides who pays an agent fee;
    // account_kind_claim() writes a row the account cannot touch and refuses
    // the claim for anybody already trading as an agent. A refusal is not an
    // error here: it means they are an agent, which is what they were a moment
    // ago. See supabase/features/house/house_owner_accounts.sql.
    if (type === "owner" && window.OwnerAccount) {
      try { await window.OwnerAccount.claim("owner"); } catch (_) {}
    }

    // A company and a plain user each have exactly one place to be, so send
    // them there. An agent or an owner may hold several portals, and the
    // chooser below already works that out by asking what they actually own —
    // which is a better answer than anything this picker could assert.
    if (autoRedirect && (type === "company" || type === "user")) {
      const m = D.meta(type);
      if (m) { location.href = m.href; return; }
    }

    show("cardPortal");
    $("portalEmail").textContent = session.user.email ||
      (session.user.is_anonymous ? T("lg_guest_name", "a guest session") : T("lg_your_account", "your account"));
    $("portalSpinner").hidden = false;
    $("portalList").innerHTML = "";
    $("portalEmpty").hidden = true;

    const mine = await detectPortals(session);
    // Exactly one thing belongs to you and you just signed in → go there.
    if (autoRedirect && mine.length === 1) { location.href = mine[0].href; return; }
    renderPortals(session, mine);
  }

  // ============================ pane: password ============================
  const pwForm = $("panePassword");
  pwForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = P.normalizeEmail($("pwEmail").value);
    const pass = $("pwPassword").value;
    const btn = $("pwSubmit");

    say("authMsg", "", "");
    hint("pwEmail", "pwEmailHint", "", "");
    if (!P.isEmail(email)) {
      hint("pwEmail", "pwEmailHint", "error", T("lg_v_email", "Enter a complete email address."));
      $("pwEmail").focus();
      return;
    }
    if (!pass) {
      hint("pwPassword", "pwPassHint", "error", T("lg_v_password", "Enter your password."));
      $("pwPassword").focus();
      return;
    }
    if (!throttleCheck(email, btn, "authMsg")) return;

    busy(btn, true, T("lg_signing_in", "Signing you in…"));
    try {
      const session = await A.signIn(email, pass);
      if (store) {
        P.recordSuccess(store, email);
        if ($("rememberMe").checked) store.setItem(REMEMBER_KEY, email);
        else store.removeItem(REMEMBER_KEY);
      }
      busy(btn, false);
      await routeSignedIn(session, { autoRedirect: true });
    } catch (err) {
      busy(btn, false);
      const code = E.code(err);
      // An unconfirmed address is not a wrong password; offer the fix.
      if (code === "email_not_confirmed") {
        pendingEmail = email;
        showSent("confirm", email);
        return;
      }
      const wait = E.retryAfter(err);
      if (store && wait) P.lockFor(store, email, wait);
      else if (store && code === "invalid_credentials") {
        const st = P.recordFailure(store, email);
        if (st.locked) { lockUI(st.secondsLeft, btn, "authMsg"); return; }
        if (st.remaining <= 2) {
          say("authMsg", "error", E.message(err) + " " +
            T("lg_tries_left", "{n} tries left before a short pause.").replace("{n}", String(st.remaining)));
          return;
        }
      }
      say("authMsg", "error", E.message(err));
      if (E.isUserFixable(err)) $("pwPassword").select();
    }
  });

  // ============================ pane: email code ==========================
  let codeEmail = "";
  let resendLeft = 0, resendTick = null;

  function startResendCooldown(seconds) {
    resendLeft = seconds;
    const btn = $("codeResend");
    const idle = T("lg_code_resend", "Send another code");
    if (resendTick) clearInterval(resendTick);
    const paint = () => {
      if (resendLeft <= 0) {
        clearInterval(resendTick); resendTick = null;
        btn.disabled = false; btn.textContent = idle;
        return;
      }
      btn.disabled = true;
      btn.textContent = T("lg_code_wait", "Send another in {s}s").replace("{s}", String(resendLeft));
      resendLeft--;
    };
    paint();
    resendTick = setInterval(paint, 1000);
  }

  async function sendCode(btn) {
    const email = P.normalizeEmail($("codeEmail").value);
    say("authMsg", "", "");
    if (!P.isEmail(email)) {
      hint("codeEmail", "codeAskHint", "error", T("lg_v_email", "Enter a complete email address."));
      $("codeEmail").focus();
      return;
    }
    if (!throttleCheck(email, btn, "authMsg")) return;

    busy(btn, true, T("lg_sending", "Sending…"));
    try {
      await A.sendCode(email, { createUser: false });
      codeEmail = email;
      $("codeStepAsk").hidden = true;
      $("codeStepEnter").hidden = false;
      $("codeSentTo").textContent = T("lg_code_sent_to", "Sent to {email}. It works once, within the hour.")
        .replace("{email}", email);
      $("codeInput").value = "";
      $("codeInput").focus();
      startResendCooldown(RESEND_COOLDOWN_S);
      say("authMsg", "ok", T("lg_code_sent", "Code sent. Check your inbox, and the spam folder."));
    } catch (err) {
      const wait = E.retryAfter(err);
      if (store && wait) P.lockFor(store, email, wait);
      say("authMsg", "error", E.message(err));
    } finally {
      busy(btn, false);
    }
  }

  $("codeSend").addEventListener("click", () => sendCode($("codeSend")));
  $("codeResend").addEventListener("click", async () => {
    if (resendLeft > 0) return;
    $("codeEmail").value = codeEmail;
    await sendCode($("codeResend"));
  });
  $("codeChange").addEventListener("click", () => {
    $("codeStepEnter").hidden = true;
    $("codeStepAsk").hidden = false;
    say("authMsg", "", "");
    $("codeEmail").focus();
  });

  // Keep the field to digits and submit the moment six of them are there —
  // typing a code then hunting for a button is a pointless extra step.
  const codeInput = $("codeInput");
  codeInput.addEventListener("input", () => {
    const cleaned = codeInput.value.replace(/\D/g, "").slice(0, 6);
    if (cleaned !== codeInput.value) codeInput.value = cleaned;
    codeInput.removeAttribute("aria-invalid");
    if (cleaned.length === 6) $("paneCode").requestSubmit
      ? $("paneCode").requestSubmit()
      : verifyCode();
  });

  async function verifyCode() {
    const token = codeInput.value.replace(/\D/g, "");
    const btn = $("codeVerify");
    if (token.length !== 6) {
      codeInput.setAttribute("aria-invalid", "true");
      say("authMsg", "error", T("lg_v_code", "Enter all six digits."));
      return;
    }
    busy(btn, true, T("lg_checking", "Checking…"));
    try {
      const session = await A.verifyCode(codeEmail, token, "email");
      if (store) { P.recordSuccess(store, codeEmail); store.setItem(REMEMBER_KEY, codeEmail); }
      busy(btn, false);
      await routeSignedIn(session, { autoRedirect: true });
    } catch (err) {
      busy(btn, false);
      codeInput.setAttribute("aria-invalid", "true");
      codeInput.select();
      say("authMsg", "error", E.message(err));
      if (store) P.recordFailure(store, codeEmail);
    }
  }

  $("paneCode").addEventListener("submit", (e) => { e.preventDefault(); verifyCode(); });

  // ============================ pane: create account ======================
  function paintMeter(pw, email, meterId, sayId, reqsId) {
    const res = P.scorePassword(pw, email);
    const meter = $(meterId);
    if (meter) meter.setAttribute("data-score", String(res.score));
    const sayEl = $(sayId);
    if (sayEl) {
      const LABEL = {
        "": T("lg_pw_empty", "Pick something only you would type."),
        weak: T("lg_pw_weak", "Weak"),
        fair: T("lg_pw_fair", "Fair"),
        good: T("lg_pw_good", "Good"),
        strong: T("lg_pw_strong", "Strong"),
      };
      const WHY = {
        length: T("lg_pw_why_length", "Make it at least 8 characters."),
        common: T("lg_pw_why_common", "That one is on every guessing list."),
        varied: T("lg_pw_why_varied", "A straight run of characters is easy to guess."),
        email: T("lg_pw_why_email", "Don't put your email address in it."),
        letter: T("lg_pw_why_letter", "Add a letter."),
        number: T("lg_pw_why_number", "Add a number."),
      };
      sayEl.innerHTML = "";
      const b = document.createElement("b");
      b.textContent = pw ? LABEL[res.label] || "" : "";
      sayEl.appendChild(b);
      const tail = document.createTextNode(
        pw ? (res.failed && WHY[res.failed] ? " — " + WHY[res.failed] : "") : LABEL[""]);
      sayEl.appendChild(tail);
    }
    const reqs = $(reqsId);
    if (reqs) {
      reqs.querySelectorAll("li[data-req]").forEach((li) => {
        li.classList.toggle("is-met", !!(pw && res.checks[li.dataset.req]));
      });
    }
    return res;
  }

  $("suPassword").addEventListener("input", () => {
    paintMeter($("suPassword").value, $("suEmail").value, "suMeter", "suMeterSay", "suReqs");
    if ($("suConfirm").value) checkConfirm();
  });
  $("suEmail").addEventListener("input", () => {
    if ($("suPassword").value) paintMeter($("suPassword").value, $("suEmail").value, "suMeter", "suMeterSay", "suReqs");
  });

  function checkConfirm() {
    const a = $("suPassword").value, b = $("suConfirm").value;
    if (b && a !== b) {
      hint("suConfirm", "suConfirmHint", "error", T("lg_v_match", "The two passwords don't match."));
      return false;
    }
    hint("suConfirm", "suConfirmHint", "", "");
    return true;
  }
  $("suConfirm").addEventListener("input", checkConfirm);
  watchCaps("suPassword", "suConfirmHint");

  let pendingEmail = "";

  $("paneSignup").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = P.normalizeEmail($("suEmail").value);
    const pass = $("suPassword").value;
    const btn = $("suSubmit");
    say("authMsg", "", "");

    if (!P.isEmail(email)) {
      hint("suEmail", "suEmailHint", "error", T("lg_v_email", "Enter a complete email address."));
      $("suEmail").focus();
      return;
    }
    hint("suEmail", "suEmailHint", "", "");
    const res = paintMeter(pass, email, "suMeter", "suMeterSay", "suReqs");
    if (!res.ok) {
      say("authMsg", "error", T("lg_v_weak", "Strengthen your password before continuing."));
      $("suPassword").focus();
      return;
    }
    if (!checkConfirm() || !$("suConfirm").value) {
      hint("suConfirm", "suConfirmHint", "error", T("lg_v_match", "The two passwords don't match."));
      $("suConfirm").focus();
      return;
    }

    busy(btn, true, T("lg_creating", "Creating your account…"));
    try {
      // The door travels with the account. Auth.signUp already forwards a
      // metadata object, so this needs no schema and no second write. It is a
      // signpost, never a permission — js/lib/login-doors.js says why.
      const chosen = D && D.get();
      const out = await A.signUp(email, pass, chosen ? { account_type: chosen } : undefined);
      if (store) store.setItem(REMEMBER_KEY, email);
      busy(btn, false);
      pendingEmail = email;
      if (out && out.needsConfirmation) { showSent("confirm", email); return; }
      if (out && out.session) { await routeSignedIn(out.session, { autoRedirect: true }); return; }
      showSent("confirm", email);
    } catch (err) {
      busy(btn, false);
      const code = E.code(err);
      if (code === "user_already_exists") {
        // Send them where they can actually get in, with the email carried over.
        $("pwEmail").value = email;
        setMethod("password");
        say("authMsg", "info", E.message(err));
        $("pwPassword").focus();
        return;
      }
      say("authMsg", "error", E.message(err));
    }
  });

  // ============================ "check your inbox" ========================
  // One card, two reasons to be here: a new account awaiting confirmation, or
  // a password reset that was requested. `sentMode` decides what resend does.
  let sentMode = "confirm";

  function showSent(mode, email) {
    sentMode = mode;
    pendingEmail = email;
    show("cardSent");
    $("sentBody").textContent = mode === "reset"
      ? T("lg_sent_reset", "If {email} has an account, a reset link is on its way. Open it on this device and we'll take it from there.")
          .replace("{email}", email)
      : T("lg_sent_confirm", "We sent a confirmation link to {email}. Open it to finish creating your account, then come back and sign in.")
          .replace("{email}", email);
    say("sentMsg", "", "");
    const btn = $("sentResend");
    btn.disabled = false;
    btn.textContent = T("lg_sent_resend", "Send it again");
  }

  $("sentResend").addEventListener("click", async () => {
    const btn = $("sentResend");
    if (!pendingEmail) return;
    busy(btn, true, T("lg_sending", "Sending…"));
    try {
      if (sentMode === "reset") await sendResetFor(pendingEmail);
      else if (A.resendConfirmation) await A.resendConfirmation(pendingEmail);
      say("sentMsg", "ok", T("lg_sent_again", "Sent. Give it a minute, then check spam too."));
      busy(btn, false);
      btn.disabled = true;
      setTimeout(() => { btn.disabled = false; }, RESEND_COOLDOWN_S * 1000);
    } catch (err) {
      busy(btn, false);
      say("sentMsg", "error", E.message(err));
    }
  });

  // ============================ forgot password ===========================
  async function sendResetFor(email) {
    // The Clerk facade does the whole thing in a modal and hands back a
    // session; the ordinary path emails a link back to this page.
    if (A.resetPassword) return await A.resetPassword(email);
    return await A.sendReset(email);
  }

  $("forgotBtn").addEventListener("click", async (e) => {
    e.preventDefault();
    const email = P.normalizeEmail($("pwEmail").value);
    if (!P.isEmail(email)) {
      hint("pwEmail", "pwEmailHint", "error",
        T("lg_v_email_first", "Type your email above first, then tap Forgot password."));
      $("pwEmail").focus();
      return;
    }
    const btn = $("forgotBtn");
    btn.disabled = true;
    try {
      const maybeSession = await sendResetFor(email);
      // Clerk's modal path resolves with a live session — the person is in.
      if (maybeSession && maybeSession.user) {
        await routeSignedIn(maybeSession, { autoRedirect: true });
        return;
      }
      // Deliberately says "if it has an account". Confirming which addresses
      // are registered hands an attacker a list of valid targets for free.
      showSent("reset", email);
    } catch (err) {
      say("authMsg", "error", E.message(err));
    } finally {
      btn.disabled = false;
    }
  });

  // ============================ recovery landing ==========================
  $("recPassword").addEventListener("input", () => {
    paintMeter($("recPassword").value, "", "recMeter", "recMeterSay", null);
  });

  $("formRecovery").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pass = $("recPassword").value;
    const btn = $("recSubmit");
    say("recMsg", "", "");
    const res = P.scorePassword(pass, "");
    if (!res.ok) {
      say("recMsg", "error", T("lg_v_weak", "Strengthen your password before continuing."));
      $("recPassword").focus();
      return;
    }
    busy(btn, true, T("lg_saving", "Saving…"));
    try {
      await A.updatePassword(pass);
      say("recMsg", "ok", T("lg_rec_ok", "Password updated. Taking you in…"));
      const session = await A.getSession();
      busy(btn, false);
      setTimeout(() => routeSignedIn(session, { autoRedirect: true }), 700);
    } catch (err) {
      busy(btn, false);
      say("recMsg", "error", E.message(err));
    }
  });

  // ============================ passkeys ==================================
  // Only drawn when this browser and this client can genuinely do it. A button
  // that fails on tap is worse than no button.
  if (A.supportsPasskeys && A.supportsPasskeys()) {
    $("passkeyBlock").hidden = false;
    $("passkeyBtn").addEventListener("click", async () => {
      const btn = $("passkeyBtn");
      busy(btn, true, T("lg_passkey_wait", "Waiting for your device…"));
      try {
        const sb = window.SB;
        const { data, error } = await sb.auth.signInWithWebAuthn({ email: P.normalizeEmail($("pwEmail").value) || undefined });
        if (error) throw error;
        busy(btn, false);
        await routeSignedIn(data && data.session, { autoRedirect: true });
      } catch (err) {
        busy(btn, false);
        say("authMsg", "error", E.message(err));
      }
    });
  }

  // ============================ sign out ==================================
  $("portalSignOut").addEventListener("click", async () => {
    await A.signOut();
    $("pwPassword").value = "";
    show("cardAuth");
    setMethod("password");
    say("authMsg", "ok", T("lg_signed_out", "Signed out. Use any account below."));
  });

  // ============================ boot ======================================
  // Remembered address, so the common case is one field and a tap.
  if (store) {
    const last = store.getItem(REMEMBER_KEY);
    if (last && P.isEmail(last)) {
      $("pwEmail").value = last;
      $("codeEmail").value = last;
      setTimeout(() => $("pwPassword").focus(), 60);
    }
  }
  // ?m=signup / ?m=code lets other pages point straight at the right pane.
  const wanted = new URLSearchParams(location.search).get("m");
  if (PANES[wanted]) setMethod(wanted);

  // No client at all (bad config, blocked script, first load offline). Say what
  // the person can do, not what broke.
  if (A.isReady && !A.isReady()) {
    document.querySelectorAll("#cardAuth input, #cardAuth button.lg-btn").forEach((el) => { el.disabled = true; });
    say("authMsg", "error", E.message("unavailable"));
  }

  // The reset-link landing. The provider fires PASSWORD_RECOVERY once it has
  // exchanged the link for a session.
  let inRecovery = false;
  if (A.onAuthChange) {
    const sb = window.SB;
    try {
      sb && sb.auth.onAuthStateChange((event) => {
        if (event === "PASSWORD_RECOVERY") { inRecovery = true; show("cardRecovery"); $("recPassword").focus(); }
      });
    } catch (_) {}
  }

  // A door already chosen is a question already answered. Somebody coming back
  // to sign in should not have to say who they are a second time — the chip at
  // the top of the card still says which door they are in, and still changes it.
  if (D) {
    const remembered = D.get();
    if (remembered) { paintChosen(remembered); show("cardAuth"); }
    else paintRail("stepDoor");
  }

  // ---- the aurora follows the pointer -------------------------------------
  // Two custom properties, a 2vmax throw, and a long ease. It is felt rather
  // than seen: the background moves with you slightly, so the page reads as
  // held rather than printed. Skipped entirely for a coarse pointer (there is
  // no hover on a phone, and a touch would jump it) and for reduced motion.
  (() => {
    let ok = true;
    try {
      ok = !window.matchMedia("(prefers-reduced-motion: reduce)").matches &&
           window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    } catch (_) { ok = false; }
    const sky = document.querySelector(".lg-aurora");
    if (!ok || !sky) return;
    let queued = false, mx = 0, my = 0;
    window.addEventListener("pointermove", (e) => {
      mx = (e.clientX / window.innerWidth - 0.5) * -1;
      my = (e.clientY / window.innerHeight - 0.5) * -1;
      if (queued) return;
      queued = true;
      // One write per frame. Without this the property is set on every
      // pointermove, which on a laptop trackpad is several hundred a second.
      requestAnimationFrame(() => {
        queued = false;
        sky.style.setProperty("--px", mx.toFixed(3));
        sky.style.setProperty("--py", my.toFixed(3));
      });
    }, { passive: true });
  })();

  (async () => {
    if (/type=recovery/.test(location.hash || "")) return;   // handler above takes over
    const session = await A.getSession();
    if (session && !inRecovery) routeSignedIn(session, { autoRedirect: false });
  })();

  // Clerk mode replaces window.Auth once it finishes loading (async), so
  // re-check then. No-op otherwise — the event never fires.
  window.addEventListener("clerk-ready", async () => {
    if (inRecovery) return;
    const session = await window.Auth.getSession();
    if (session) routeSignedIn(session, { autoRedirect: false });
  });
};
