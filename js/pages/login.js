// =====================================================
// Unified sign-in page (login.html)
// One Supabase session works across every portal on this origin, so this
// page signs the user in once, detects which portal(s) their account is
// linked to, and routes them there:
//   - admin    → admin.html          (email in APP_CONFIG.ADMIN_EMAILS)
//   - houses   → agent-houses.html   (houses.owner_user_id)
//   - trucks   → agent-trucks.html   (trucks.owner_user_id)
//   - services → agent-services.html (services.owner_user_id)
// Also handles "forgot password" + the recovery link flow (Supabase emits
// PASSWORD_RECOVERY when the user lands here from the reset email).
// =====================================================

window.initLoginPage = () => {
  const sb = window.SB || (window.DataStore && window.DataStore.sb);

  const loginCard    = document.getElementById("loginCard");
  const portalCard   = document.getElementById("portalCard");
  const recoveryCard = document.getElementById("recoveryCard");
  const form         = document.getElementById("loginForm");
  const emailEl      = document.getElementById("loginEmail");
  const passEl       = document.getElementById("loginPassword");
  const loginBtn     = document.getElementById("loginBtn");
  const statusEl     = document.getElementById("loginStatus");
  const forgotBtn    = document.getElementById("forgotBtn");
  const portalEmail  = document.getElementById("portalEmail");
  const portalList   = document.getElementById("portalList");
  const portalEmpty  = document.getElementById("portalEmpty");
  const portalSpin   = document.getElementById("portalSpinner");

  if (!sb) {
    showStatus("err", "Supabase is not configured — sign-in is unavailable.");
    return;
  }

  // SVG icon markup (Lucide-style strokes) — no emoji, theme-aware.
  const svg = (paths) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const ICON = {
    admin:    svg('<path d="M12 3l8 3v5c0 5-3.4 8-8 10-4.6-2-8-5-8-10V6z"/><path d="m9 12 2 2 4-4"/>'),
    houses:   svg('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9.5 21v-6h5v6"/>'),
    trucks:   svg('<path d="M1 6h13v9H1z"/><path d="M14 9h4l3 3v3h-7z"/><circle cx="5.5" cy="18" r="1.7"/><circle cx="17.5" cy="18" r="1.7"/>'),
    services: svg('<path d="M14.7 6.3a4 4 0 0 0-5.4 5.3L3 18l3 3 6.4-6.3a4 4 0 0 0 5.3-5.4l-2.9 2.9-2.1-2.1z"/>'),
    parcel:   svg('<path d="M12 3 3 7.5V17l9 4 9-4V7.5z"/><path d="M3 7.5 12 12l9-4.5"/><path d="M12 12v9"/>'),
    go:       svg('<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>'),
  };

  // The portals an account can be linked to, in redirect priority order.
  const PORTALS = [
    { key: "admin",    href: "admin.html",          icon: ICON.admin,    label: "System admin",
      sub: "Agents, listings, tenants, day jobs" },
    { key: "houses",   href: "agent-houses.html",   icon: ICON.houses,   label: "Houses portal",
      sub: "Your property listings & tenants" },
    { key: "trucks",   href: "agent-trucks.html",   icon: ICON.trucks,   label: "Trucks portal",
      sub: "Your moving-truck listings" },
    { key: "services", href: "agent-services.html", icon: ICON.services, label: "Services portal",
      sub: "Your daily-services listings" },
  ];

  // Map a status kind ("err"/"ok") to the auth.css modifier class.
  function showStatus(kind, msg) {
    if (!statusEl) return;
    const mod = kind === "err" ? "is-error" : kind === "ok" ? "is-ok" : "";
    statusEl.className = "auth-msg" + (mod && msg ? " " + mod + " is-show" : "");
    statusEl.textContent = msg || "";
  }
  function show(card) {
    [loginCard, portalCard, recoveryCard].forEach((c) => { if (c) c.hidden = c !== card; });
  }

  // ---- Show/hide password toggles -----------------------------------------
  function wireToggle(btnId, inputEl) {
    const btn = document.getElementById(btnId);
    btn?.addEventListener("click", () => {
      const show = inputEl.type === "password";
      inputEl.type = show ? "text" : "password";
      btn.setAttribute("aria-pressed", String(show));
      btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
    });
  }
  wireToggle("pwToggle", passEl);
  wireToggle("pwToggle2", document.getElementById("newPassword"));

  // ---- Which portals does this account belong to? --------------------------
  // Every probe is independent and failure-tolerant: a missing table or RLS
  // denial simply means "not linked to that portal".
  async function detectPortals(session) {
    const uid = session.user.id;
    const email = session.user.email || "";
    const found = new Set();
    if (window.Auth && window.Auth.isAllowedEmail(email)) found.add("admin");
    const probe = async (p, key) => {
      try {
        const { data, error } = await p;
        if (error) return;
        const hit = Array.isArray(data) ? data.length > 0 : !!data;
        if (hit) found.add(key);
      } catch (_) {}
    };
    await Promise.all([
      probe(sb.from("houses").select("id").eq("owner_user_id", uid).limit(1), "houses"),
      probe(sb.from("trucks").select("id").eq("owner_user_id", uid).limit(1), "trucks"),
      probe(sb.from("services").select("id").eq("owner_user_id", uid).limit(1), "services"),
    ]);
    return PORTALS.filter((p) => found.has(p.key));
  }

  function renderPortalChooser(session, mine) {
    show(portalCard);
    if (portalEmail) portalEmail.textContent = session.user.email || "your account";
    if (portalSpin) portalSpin.style.display = "none";
    portalList.innerHTML = "";
    const list = mine.length ? mine : PORTALS;
    if (!mine.length && portalEmpty) {
      portalEmpty.hidden = false;
      portalEmpty.innerHTML =
        "This account isn't linked to a portal yet. If you just registered, open the portal " +
        "you signed up in; otherwise pick where you want to go:";
    } else if (portalEmpty) {
      portalEmpty.hidden = true;
    }
    for (const p of list) {
      const a = document.createElement("a");
      a.className = "auth-portal";
      a.href = p.href;
      a.innerHTML = `<span class="auth-route-ic">${p.icon}</span>
        <span>${p.label}<small>${p.sub}</small></span>
        <span class="auth-route-go">${ICON.go}</span>`;
      portalList.appendChild(a);
    }
  }

  async function routeSignedIn(session, { autoRedirect } = {}) {
    show(portalCard);
    if (portalEmail) portalEmail.textContent = session.user.email || "your account";
    if (portalSpin) portalSpin.style.display = "";
    portalList.innerHTML = "";
    if (portalEmpty) portalEmpty.hidden = true;
    const mine = await detectPortals(session);
    // Fresh sign-in with exactly one linked portal → go straight there.
    if (autoRedirect && mine.length === 1) {
      location.href = mine[0].href;
      return;
    }
    renderPortalChooser(session, mine);
  }

  // ---- Sign in --------------------------------------------------------------
  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = emailEl.value.trim();
    const pass  = passEl.value;
    if (!email || !pass) { showStatus("err", "Enter your email and password."); return; }
    loginBtn.disabled = true;
    loginBtn.textContent = "Signing in…";
    showStatus("", "");
    try {
      // signIn returns a session. Under Clerk, a new-device code / 2FA step is
      // handled transparently by a shared modal inside Auth.signIn.
      const session = await window.Auth.signIn(email, pass);
      await routeSignedIn(session, { autoRedirect: true });
    } catch (err) {
      const msg = /invalid login/i.test(err.message || "")
        ? "Wrong email or password. If you registered in an agent portal, use that same email."
        : (err.message || "Could not sign in.");
      showStatus("err", msg);
    } finally {
      loginBtn.disabled = false;
      loginBtn.textContent = "Sign in";
    }
  });

  // ---- Forgot password ------------------------------------------------------
  forgotBtn?.addEventListener("click", async () => {
    const email = emailEl.value.trim();
    if (!email) {
      showStatus("err", "Type your email above first, then tap “Forgot password?” again.");
      emailEl.focus();
      return;
    }
    forgotBtn.disabled = true;
    try {
      if (window.Auth && window.Auth.resetPassword) {
        // Clerk: emails a code; a modal collects code + new password and signs in.
        const session = await window.Auth.resetPassword(email);
        if (session) { showStatus("ok", "Password updated — signing you in…"); await routeSignedIn(session, { autoRedirect: true }); }
        else showStatus("", "");   // user cancelled the modal
      } else {
        // Supabase Auth: email a reset link back to this page.
        const redirectTo = location.origin + location.pathname;
        const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo });
        if (error) throw error;
        showStatus("ok", `Reset link sent to ${email} — check your inbox (and spam), then follow the link back here.`);
      }
    } catch (err) {
      showStatus("err", err.message || "Could not reset your password.");
    } finally {
      forgotBtn.disabled = false;
    }
  });

  // ---- Recovery flow (arrived from the reset email) -------------------------
  let inRecovery = false;
  sb.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY") {
      inRecovery = true;
      show(recoveryCard);
    }
  });

  document.getElementById("recoveryForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const newPass = document.getElementById("newPassword").value;
    const rBtn    = document.getElementById("recoveryBtn");
    const rStatus = document.getElementById("recoveryStatus");
    const say = (kind, msg) => {
      const mod = kind === "err" ? "is-error" : kind === "ok" ? "is-ok" : "";
      rStatus.className = "auth-msg" + (mod && msg ? " " + mod + " is-show" : "");
      rStatus.textContent = msg || "";
    };
    if (newPass.length < 8) { say("err", "Use at least 8 characters."); return; }
    rBtn.disabled = true;
    rBtn.textContent = "Saving…";
    try {
      const { error } = await sb.auth.updateUser({ password: newPass });
      if (error) throw error;
      say("ok", "Password updated — taking you to your portal…");
      const { data } = await sb.auth.getSession();
      if (data.session) setTimeout(() => routeSignedIn(data.session, { autoRedirect: true }), 900);
    } catch (err) {
      say("err", err.message || "Could not update the password.");
    } finally {
      rBtn.disabled = false;
      rBtn.textContent = "Save new password";
    }
  });

  // ---- Sign out (from the portal chooser) -----------------------------------
  document.getElementById("portalSignOut")?.addEventListener("click", async () => {
    try { await window.Auth.signOut(); } catch (_) {}
    show(loginCard);
    passEl.value = "";
  });

  // ---- Initial state ---------------------------------------------------------
  // Already signed in (session persisted) → show the portal chooser. Recovery
  // links are handled by the PASSWORD_RECOVERY event above; give it a moment
  // to fire before deciding.
  (async () => {
    const hashIsRecovery = /type=recovery/.test(location.hash || "");
    if (hashIsRecovery) return;            // PASSWORD_RECOVERY handler takes over
    const session = await window.Auth.getSession();
    if (session && !inRecovery) routeSignedIn(session, { autoRedirect: false });
  })();

  // Clerk mode: window.Auth is replaced once Clerk finishes loading (async),
  // so re-check then — routes an already-signed-in returning user without a
  // manual refresh. No-op outside Clerk mode (the event never fires).
  window.addEventListener("clerk-ready", async () => {
    if (inRecovery) return;
    const session = await window.Auth.getSession();
    if (session) routeSignedIn(session, { autoRedirect: false });
  });
};
