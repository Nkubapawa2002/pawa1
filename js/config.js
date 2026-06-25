// =====================================================
// Maisha na Lifeza - Configuration
// =====================================================
// IMPORTANT for production: never commit real keys to a public repo.
// For demo / static hosting, anon keys + Row-Level-Security policies are OK.

window.APP_CONFIG = {
  // ---------- Supabase ----------
  SUPABASE_URL: "https://kkdpacoiwntrcukgwksh.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_qDfG71jBmWEG-JA_Xdh2MA_m6krC_8o",

  // ---------- Clerk auth (optional · js/auth-clerk.js) ----------
  // Identity provider, used as Supabase's THIRD-PARTY auth issuer so Row-Level
  // Security keeps working (it reads the Clerk user id from the token).
  //
  // The keys below are the PUBLISHABLE key + Frontend-API domain (both are
  // public-safe — the publishable key ships to the browser by design). NEVER
  // put the Clerk SECRET key (sk_…) here; it's server-side only and unused here.
  //
  // IMPORTANT: keys present ≠ Clerk active. Clerk only turns on when USE_CLERK
  // is true AND the keys are set. Leave USE_CLERK false until you've completed
  // the SupabaseClerk dashboard setup in docs/CLERK_SETUP.md — otherwise
  // Supabase will reject Clerk tokens and authenticated requests will fail.
  //
  // KEEP THIS FALSE FOR PRODUCTION: a Clerk user id ("user_xxx") is NOT a UUID,
  // so when Supabase Storage stamps objects.owner_id (a uuid column) from the
  // JWT `sub`, every authenticated upload — house photos, truck/service media —
  // fails with `invalid input syntax for type uuid`. Native Supabase Auth issues
  // real UUID ids, so Storage + RLS + owner_user_id all work. Only flip this on
  // after the full Clerk↔Supabase setup (incl. a UUID-shaped subject claim).
  USE_CLERK: false,
  CLERK_PUBLISHABLE_KEY: "pk_test_ZGlzY3JldGUtcHJhd24tNTcuY2xlcmsuYWNjb3VudHMuZGV2JA",
  CLERK_DOMAIN: "discrete-prawn-57.clerk.accounts.dev",
  // Clerk JWT template that adds the claims Supabase RLS needs: `role`
  // (=authenticated, so RLS treats the request as a logged-in user) and `email`
  // (so is_admin()/is_super_admin(), which match auth.jwt()->>'email', work).
  // The browser mints tokens with getToken({ template: CLERK_JWT_TEMPLATE }).
  // The default session token omits email, which would break admin access.
  CLERK_JWT_TEMPLATE: "supabase",

  // Public bucket names
  BUS_PHOTOS_BUCKET: "bus-photos",
  AGENT_PHOTOS_BUCKET: "agent-photos",
  SITE_PHOTOS_BUCKET: "site-photos",
  HOUSE_PHOTOS_BUCKET: "house-photos",
  TRUCK_PHOTOS_BUCKET: "truck-photos",
  SERVICE_PHOTOS_BUCKET: "service-photos",

  // ---------- Map / geocoding (LocationIQ, called directly by js/geo.js) ------
  // The browser geocodes through LocationIQ (hosted, CORS-enabled). This is a
  // CLIENT-SIDE key: restrict it to your domain(s) in the LocationIQ dashboard
  // (Account → restrict by referer) so it can't be reused elsewhere — the same
  // pattern as a Mapbox/Google Maps browser key. Free tier: 5,000 lookups/day.
  LOCATIONIQ_KEY: "pk.3ed6d1197fc3f49a728d0135030d3d89",

  // Legacy: the old self-hosted Go map gateway. No longer used by js/geo.js
  // (the browser now calls LocationIQ directly). Kept for reference only.
  GEO_GATEWAY_URL: "https://pawa-map-gateway.onrender.com",

  // ---------- Video faststart gateway (services/python) ----------
  // Public URL of the Python service that remuxes uploaded house videos to MP4
  // "faststart" (moov atom to the front) so they stream without stutter. The
  // houses uploader POSTs each clip here before storing it, and silently falls
  // back to the original file if this is unset/unreachable. Leave empty to
  // auto-use http://127.0.0.1:8094 on localhost. Set to your deployed URL (no
  // trailing slash) to enable it in production.
  VIDEO_GATEWAY_URL: "https://pawa-video-gateway-oymf.onrender.com",

  // Emails allowed to log into admin.html (must also exist in `admins` table for RLS).
  ADMIN_EMAILS: ["pawa4761@gmail.com"],

  // ---------- n8n Automation ----------
  // Base URL of your n8n instance (no trailing slash).
  // All webhook calls from the dashboard go to: N8N_WEBHOOK_BASE + /webhook/...
  N8N_WEBHOOK_BASE: "https://your-n8n.yourdomain.com",

  // ---------- Anthropic AI Chat ----------
  // Claude is the brain of the voice + chat agent, but the API key
  // NEVER lives in the browser. It is configured in:
  //   • VAPI assistant → Provider Keys → Anthropic                 (for voice calls)
  //   • Supabase Edge Function secrets → ANTHROPIC_API_KEY         (for ai-chat / ai-think / ai-map)
  //   • Tenant settings (encrypted) → per-tenant agent-chat        (for dashboard agent)
  // The browser calls the Edge Functions below; they hold the key.
  ANTHROPIC_API_KEY: "",                            // do not set — server-side only
  ANTHROPIC_MODEL: "claude-opus-4-7",               // pinned to match VAPI config
  ANTHROPIC_API_URL: "https://api.anthropic.com/v1/messages",

  // Edge Function endpoints (paths are appended to SUPABASE_URL at call time).
  AI_CHAT_PATH:   "/functions/v1/ai-chat",          // generic conversational replies
  AI_THINK_PATH:  "/functions/v1/ai-think",         // structured decision / algorithm
  AI_MAP_PATH:    "/functions/v1/ai-map",           // NL → map intent
  AI_SEARCH_PATH: "/functions/v1/ai-search",        // NL → house/ride/near-me search intent
  SEND_SMS_PATH:  "/functions/v1/send-sms",          // admin → agent SMS fallback (deploy supabase/functions/send-sms)
  // Master switch for the AI search brain (houses smart-search + ride trip box
  // + near-me AI search). Now LIVE: ai-search is deployed on Gemini (reuses
  // GEMINI_API_KEY, --no-verify-jwt). Everything still works without it
  // (regex parser / plain-geocode fallback).
  AI_SEARCH_ENABLED: true,
  // Optional full-URL override for ai-search (e.g. a self-hosted Python server
  // at services/python). Setting this auto-enables AI regardless of the flag
  // above — handy for local testing. Leave empty to use SUPABASE_URL + path.
  AI_SEARCH_URL: "",

  // ---------- Agent subscriptions ----------
  // Admin-controlled billing, NO payment gateway (gateway comes later). Every
  // agent (house owner, truck owner, service provider, bus/cargo) pays this
  // monthly fee to the admin offline; the admin records it in admin.html →
  // "All Agents" and the amount sets how long coverage lasts. Authoritative DB
  // logic: supabase/agent_billing_setup.sql; these mirror it for the UI copy.
  AGENT_MONTHLY_FEE_TZS: 10000,
  // Legacy 48h "pay-or-pause" grace — no longer enforced (the model is now
  // approval-based, see AGENT_APPROVAL_DAYS). Kept only for old UI copy paths.
  AGENT_GRACE_HOURS: 48,
  // New agents are live immediately but must be APPROVED by an admin within this
  // many days of registering, or their listings auto-hide until approved.
  // Enforced in supabase/agent_billing_setup.sql; mirrored here for the UI copy.
  AGENT_APPROVAL_DAYS: 7,

  // ---------- Hidden navigation ----------
  // Pages listed here are hidden from the top nav + mobile drawer (the files
  // still exist and work if visited directly — this only removes the menu
  // links). Reversible: delete an entry to bring its menu link back.
  // The legacy bus/parcel transport pages were deleted in the housing/services
  // pivot, so there is nothing left to hide. Add a filename here to drop its
  // nav link without deleting the page.
  HIDDEN_NAV: [],

  // ---------- Insurance ----------
  INSURANCE_COVERAGE_PERCENT: 80,

  // ---------- VAPI Voice Agent ----------
  // Frontend (browser → AI) call uses VAPI_PUBLIC_KEY + VAPI_ASSISTANT_ID.
  // Outbound (AI → user phone) is triggered from the n8n workflow which
  // uses VAPI_PRIVATE_KEY + VAPI_PHONE_NUMBER_ID stored as n8n credentials —
  // do NOT put the private key here.
  VAPI_PUBLIC_KEY: "",
  VAPI_ASSISTANT_ID: "",
  VAPI_PHONE_NUMBER_ID: "",     // internal VAPI ID for the virtual number

  // ---------- Virtual Phone Number ----------
  // This is the actual number clients dial to reach the AI booking agent.
  // Host it on Africa's Talking or Twilio → point the inbound webhook to
  // your n8n instance at: N8N_WEBHOOK_BASE + /webhook/inbound-call
  // n8n then connects the caller to VAPI and handles SMS via AT/Twilio.
  VIRTUAL_PHONE_NUMBER: "",         // e.g. "+255800123456" (AT) or "+1415XXXXXXX" (Twilio)
  VIRTUAL_PHONE_DISPLAY: "",        // formatted for display e.g. "+255 800 123 456"
  SMS_PROVIDER: "africas_talking",  // "africas_talking" | "twilio"
  AT_SHORTCODE: "",                 // Africa's Talking shortcode / sender ID (for SMS display)

  // ---------- Payments ----------
  // The frontend only needs SUPABASE_URL + SUPABASE_ANON_KEY (above).
  // All provider secrets live as Supabase Edge Function env vars:
  //   PRIMARY_PROVIDER       — selcom | clickpesa | azampay | flutterwave
  //   SELCOM_API_KEY, SELCOM_API_SECRET, SELCOM_VENDOR
  //   CLICKPESA_CLIENT_ID, CLICKPESA_API_KEY, CLICKPESA_WEBHOOK_SECRET
  //   AZAMPAY_TOKEN | AZAMPAY_CLIENT_ID, AZAMPAY_CLIENT_SECRET, AZAMPAY_APP_NAME
  //   FLW_SECRET_KEY, FLW_HASH
  //   PROVIDER_MPESA / PROVIDER_TIGOPESA / … to override per-method
  // Set them with:  supabase secrets set SELCOM_API_KEY=...
  PAYMENT_METHODS_ENABLED: [
    "mpesa","tigopesa","airtel","halopesa","azampesa",
    "nmb","crdb","nbc","equity","stanbic","other_bank",
    "card","cash"
  ],

  // ---------- Gemini AI (voice + text chat on chat.html) ----------
  // The GEMINI_API_KEY is NEVER in the browser — it lives only as a Supabase
  // Edge Function secret. The browser calls two functions instead:
  //   • gemini-chat   → text replies for the AI Assistant tab
  //   • gemini-token  → mints a short-lived ephemeral token for the Voice tab,
  //                     so the browser can open a Gemini Live session without
  //                     the real key. (See supabase/functions/gemini-*.)
  // Deploy:  supabase secrets set GEMINI_API_KEY=AQ.Ab8...
  //          supabase functions deploy gemini-chat gemini-token
  GEMINI_CHAT_PATH:  "/functions/v1/gemini-chat",
  GEMINI_TOKEN_PATH: "/functions/v1/gemini-token",
  // The browser still needs the Live model name to open the session (the
  // ephemeral token authorises it, but the client picks the model).
  GEMINI_LIVE_MODEL: "gemini-2.5-flash-native-audio-preview-09-2025",
  // Model-fallback chain for the text proxy (free tier is ~20 req/day PER
  // model; the function advances on a 429 so replies stay on real AI).
  GEMINI_TEXT_MODELS: [
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-flash-latest",
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite"
  ],

  // ---------- Maps / Weather ----------
  // Leaflet uses OpenStreetMap (no key needed).
  // Open-Meteo provides current conditions (no key needed).
  // Mapbox satellite tiles need a public `pk.` token. Don't commit it to
  // this file — GitHub's secret scanner will block the push. Instead, put
  // it in `js/config.local.js` (gitignored) as:
  //   window.APP_CONFIG.MAPBOX_TOKEN = "pk....";
  // The meet / ride / track pages read it from APP_CONFIG at runtime.
  MAPBOX_TOKEN: "",

  // ---------- Approximate location fallback (js/geolocate.js) ----------
  // When precise browser GPS is denied / blocked / unavailable (e.g. desktop
  // with no GPS, location turned off, or served over plain http), the app
  // falls back to a coarse, city-level location so "Near me" still works.
  // Order: (1) Google Geolocation API if a key is set here, (2) free no-key
  // IP geolocation. Leave empty to use the free IP services only.
  //   Get a key: Google Cloud → enable "Geolocation API" → API key (restrict
  //   it by your domain). It bills per request, so restrict it.
  GOOGLE_GEOLOCATION_KEY: "",

  // ---------- WebRTC (Meet & Locate voice/video) ----------
  // STUN punches through most home/Wi-Fi NATs, but on Tanzanian MOBILE-carrier
  // networks (CGNAT / symmetric NAT) STUN-only calls can't connect — ICE goes
  // to "failed" and the call drops ("crashes"). A TURN relay fixes this by
  // forwarding the media. Use a managed TURN provider (no server to run):
  //   • metered.ca (free tier) · Cloudflare Realtime TURN · Twilio NTS
  // Paste the credentials they give you below. Leave TURN_URLS empty to stay
  // STUN-only (Wi-Fi-only reliability). The two Google STUN servers are always
  // included automatically. For secrets you don't want committed, set them in
  // js/config.local.js instead:  window.APP_CONFIG.TURN_CREDENTIAL = "...";
  //
  // FOR NOW: a FREE shared public TURN relay (Metered "OpenRelay" — no signup,
  // no VPS). It works immediately but is a best-effort shared service (can be
  // slow/rate-limited at busy times), so use it to get calls connecting today.
  //
  // NEXT TIME (recommended for reliability): get your OWN free credentials
  // (metered.ca gives 50 GB/mo free, or Cloudflare Realtime TURN) and replace
  // the three values below — or set them in js/config.local.js (gitignored):
  //   window.APP_CONFIG.TURN_URLS      = ["turn:<app>.metered.live:443", "turns:<app>.metered.live:443?transport=tcp"];
  //   window.APP_CONFIG.TURN_USERNAME  = "<your-username>";
  //   window.APP_CONFIG.TURN_CREDENTIAL = "<your-credential>";
  TURN_URLS: [
    "turn:openrelay.metered.ca:80",
    "turn:openrelay.metered.ca:443",
    "turn:openrelay.metered.ca:443?transport=tcp",
  ],
  TURN_USERNAME: "openrelayproject",
  TURN_CREDENTIAL: "openrelayproject",
  STUN_URLS: [],          // optional extra STUN servers (added to Google's)

  // ---------- Support Contacts ----------
  SUPPORT_CONTACTS: [
    { role: "support_role_manager", name: "xcracker pawa",  phone: "+255 741 632 744", whatsapp: "255741622744" },
    { role: "support_role_organizer", name: "Fatuma Said", phone: "+255 713 000 002", whatsapp: "255713000002" }
  ],

  // ---------- Freight / Cargo Pricing ----------
  FREIGHT_BASE_TZS: 2000,
  FREIGHT_PER_KG_TZS: 500,
  FREIGHT_MAINTENANCE_PCT: 10,
  FREIGHT_SIZE_MULTIPLIERS: { small: 1.0, medium: 1.5, large: 2.5 },

  // ---------- Analytics (PostHog · js/analytics.js) ----------
  // Product analytics + autocapture + (optional) session replay. Leave
  // POSTHOG_KEY EMPTY to disable completely — when empty, analytics.js never
  // loads and nothing is ever sent (privacy/perf by default). To turn it on,
  // paste your PostHog *project* API key (starts with "phc_") and pick the
  // host for your cloud region. Keep the key in js/config.local.js (gitignored)
  // if you don't want it committed:  window.APP_CONFIG.POSTHOG_KEY = "phc_...";
  POSTHOG_KEY: "",
  POSTHOG_HOST: "https://us.i.posthog.com",   // EU region: https://eu.i.posthog.com

  // ---------- Currency ----------
  CURRENCY: "TZS",

  // ---------- Live FX rates (js/fx.js) ----------
  // Adds an "≈ $X" foreign equivalent next to TZS prices for diaspora /
  // international users. Source: open.er-api.com (free, no key, CORS, daily
  // updates) — from the public-apis list. Rates are cached in localStorage
  // and only refetched when older than CACHE_HOURS. Degrades silently: if
  // disabled or the fetch fails, prices simply show TZS only.
  FX: {
    ENABLED: true,
    ENDPOINT: "https://open.er-api.com/v6/latest/USD",
    DISPLAY_CURRENCY: "USD",   // what formatTZSWithUSD() appends
    CACHE_HOURS: 12
  }
};

// Format a number as TZS currency
window.formatTZS = (n) => {
  if (n == null || isNaN(n)) return "TZS 0";
  return "TZS " + Number(n).toLocaleString("en-US");
};

// ---------- Analytics bootstrap ----------
// Provide a safe no-op facade immediately so `window.Analytics.capture(...)`
// is always callable; analytics.js replaces it with the real PostHog client
// when (and only when) a key is configured.
window.Analytics = window.Analytics || { capture() {}, identify() {}, reset() {} };
if (window.APP_CONFIG.POSTHOG_KEY) {
  const _ph = document.createElement("script");
  _ph.src = "js/analytics.js";
  _ph.defer = true;
  (document.head || document.documentElement).appendChild(_ph);
}

// ---------- Clerk bootstrap ----------
// Flag the app as "Clerk mode" so js/data.js wires the Supabase client to send
// Clerk's token, then load the Clerk adapter. When no Clerk key is set this is
// a no-op and the app uses Supabase Auth exactly as before.
window.CLERK_ENABLED = !!(window.APP_CONFIG.USE_CLERK && window.APP_CONFIG.CLERK_PUBLISHABLE_KEY && window.APP_CONFIG.CLERK_DOMAIN);
if (window.CLERK_ENABLED) {
  const _ck = document.createElement("script");
  _ck.src = "js/auth-clerk.js";
  _ck.defer = true;
  (document.head || document.documentElement).appendChild(_ck);
}

// =====================================================
// Agent subscription banner — shared across all 3 agent dashboards
// =====================================================
// Renders the right notice from a my_agent_subscription() result. The live model
// is ADMIN-controlled (no payment gateway): an agent is live on registering,
// must be approved by an admin within AGENT_APPROVAL_DAYS, then stays live while
// the admin keeps their paid_until current. Reasons the RPC emits:
//   • preview          → blue: live, pending admin approval (N days left)
//   • approval_expired → red paywall: preview ended, awaiting admin approval
//   • active           → subtle status bar (renew is handled by the admin)
//   • expired          → red paywall: coverage lapsed, pay the admin to renew
//   • deactivated      → red paywall: admin switched the account off (+ reason)
//   • cancelled/overdue→ red paywall: pay the admin to reinstate
//   • none             → nothing (removes any prior banner)
// (The legacy `grace`/`grace_expired` branches below are kept for backward
//  compatibility but are no longer emitted by the current RPC.)
// opts: { mount: HTMLElement, id: string, what: "profile"|"listings"|"trucks" }
window.adminContactHtml = () => {
  const c = (window.APP_CONFIG?.SUPPORT_CONTACTS || [])[0] || {};
  const parts = [];
  if (c.whatsapp) parts.push(`<a href="https://wa.me/${c.whatsapp}" target="_blank" rel="noopener">WhatsApp ${c.phone || c.whatsapp}</a>`);
  else if (c.phone) parts.push(`<a href="tel:${String(c.phone).replace(/\s/g, "")}">Call ${c.phone}</a>`);
  const email = (window.APP_CONFIG?.ADMIN_EMAILS || [])[0];
  if (email) parts.push(`<a href="mailto:${email}">${email}</a>`);
  return parts.length ? `Contact admin: ${parts.join(" · ")}.` : "Please contact the Pawa admin.";
};

window.renderAgentSubBanner = (sub, opts) => {
  opts = opts || {};
  const mount = opts.mount;
  const id = opts.id || "agentSubPaywall";
  const what = opts.what || "profile";
  if (!mount) return;

  const prior = document.getElementById(id);
  if (prior && prior._timer) { clearInterval(prior._timer); prior._timer = null; }

  // Backward-compatible: if the RPC predates the `reason` field, derive it.
  const active = sub ? sub.active !== false : true;
  let reason = sub && sub.reason;
  if (!reason) reason = active ? "active" : "expired";

  // Nothing to show when there's no billing context at all. An ACTIVE
  // subscription still renders a subtle status bar with a proactive "Renew"
  // button (handled below) so agents can pay before they ever lapse.
  if (reason === "none") { prior?.remove(); return; }

  const fee = window.formatTZS
    ? window.formatTZS((window.APP_CONFIG?.AGENT_MONTHLY_FEE_TZS) || 10000)
    : "TZS 10,000";
  const graceH = (window.APP_CONFIG?.AGENT_GRACE_HOURS) || 48;
  const noun = what === "listings" ? "Your listings are"
             : what === "trucks"   ? "Your trucks are"
             : "Your agent profile is";
  const escTxt = (s) => String(s == null ? "" : s)
    .replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const el = prior || document.createElement("div");
  el.id = id;
  if (!prior) mount.insertBefore(el, mount.firstChild);

  // Renewals are ADMIN-ONLY: an agent never pays through the app. To extend or
  // reactivate a subscription they pay the admin, who records it in the All
  // Agents tab (the amount they pay determines how long it lasts). So every
  // "renew/pay" state simply directs the agent to contact the admin.
  const renewViaAdmin = `<div style="margin-top:10px;font-weight:600">To renew, pay the admin and they'll extend your subscription.</div>` +
    `<div style="margin-top:4px">${window.adminContactHtml()}</div>`;

  // ---- Active: subtle status bar (renew handled by the admin) ----
  if (reason === "active") {
    const pu = sub && sub.paid_until ? new Date(sub.paid_until) : null;
    const daysLeft = pu ? Math.ceil((pu - new Date()) / 86400000) : null;
    const soon = daysLeft != null && daysLeft <= 7;
    const untilStr = pu ? pu.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "";
    el.style.cssText = "margin:0 0 16px;padding:11px 16px;border-radius:12px;font-size:.9rem;line-height:1.5;" +
      (soon ? "background:#fff7ed;border:1px solid #fdba74;color:#9a3412"
            : "background:#f0fdf4;border:1px solid #bbf7d0;color:#166534");
    el.innerHTML = soon
      ? `<span>Subscription ends in <strong>${daysLeft} day${daysLeft === 1 ? "" : "s"}</strong>${untilStr ? ` (${untilStr})` : ""}.</span>` +
        ` <span>To renew, pay the admin to extend it. ${window.adminContactHtml()}</span>`
      : `<span>Subscription active${untilStr ? ` until <strong>${untilStr}</strong>` : ""}.</span>`;
    return;
  }

  // ---- New-agent approval window — live for N days, then admin must approve --
  const approvalDays = (window.APP_CONFIG && window.APP_CONFIG.AGENT_APPROVAL_DAYS) || 7;
  if (reason === "preview") {
    const dl = sub && sub.deadline ? new Date(sub.deadline) : null;
    const days = dl ? Math.max(0, Math.ceil((dl - new Date()) / 86400000)) : null;
    el.style.cssText = "margin:0 0 16px;background:#eff6ff;border:1px solid #bfdbfe;color:#1e40af;padding:12px 16px;border-radius:12px;font-size:.9rem;line-height:1.5";
    el.innerHTML = `<strong>You're live — pending admin approval.</strong> ` +
      `${noun.replace(/^Your/, "Your")} visible during a ${approvalDays}-day review` +
      `${days != null ? ` · <strong>${days} day${days === 1 ? "" : "s"} left</strong>` : ""}. ` +
      `An admin will approve your account shortly. ${window.adminContactHtml()}`;
    return;
  }
  if (reason === "approval_expired") {
    el.style.cssText = "margin:0 0 16px;background:#fef2f2;border:1px solid #fca5a5;color:#b91c1c;padding:14px 16px;border-radius:12px;font-size:.92rem;line-height:1.5";
    el.innerHTML = `<strong>Your ${approvalDays}-day preview has ended.</strong> ` +
      `${noun} hidden from clients until an admin approves your account. ${window.adminContactHtml()}`;
    return;
  }

  if (reason === "grace") {
    el.style.cssText = "margin:0 0 16px;background:#fff7ed;border:1px solid #fdba74;color:#9a3412;padding:14px 16px;border-radius:12px;font-size:.92rem;line-height:1.5";
    const deadline = sub.deadline ? new Date(sub.deadline) : null;
    const tick = () => {
      let left = "";
      if (deadline) {
        const ms = deadline - new Date();
        if (ms <= 0) { clearInterval(el._timer); location.reload(); return; }
        const h = Math.floor(ms / 3600000);
        const m = Math.floor((ms % 3600000) / 60000);
        left = ` You have <strong>${h}h ${m}m</strong> left before your account is paused.`;
      }
      el.innerHTML = `<strong> Payment required to keep your account active.</strong> ` +
        `New agents must pay the <strong>${fee}/month</strong> subscription within ${graceH} hours of registering.${left} ` +
        renewViaAdmin;
    };
    tick();
    if (deadline) el._timer = setInterval(tick, 30000);
    return;
  }

  // Blocking states — red paywall.
  el.style.cssText = "margin:0 0 16px;background:#fef2f2;border:1px solid #fca5a5;color:#b91c1c;padding:14px 16px;border-radius:12px;font-size:.92rem;line-height:1.5";
  if (reason === "deactivated") {
    // The admin-set reason (stored in the billing note) tells the agent the exact
    // problem; falls back to the subscription message when no reason was given.
    const why = (sub && sub.note && String(sub.note).trim())
      ? escTxt(sub.note)
      : `Your monthly <strong>${fee}</strong> subscription is due — please settle it.`;
    el.innerHTML = `<strong> Your account is inactive.</strong> ${noun} hidden from clients right now.` +
      `<span style="display:block;margin:6px 0;">${why}</span>` +
      `${window.adminContactHtml()} Once you reach the admin it'll be sorted out as fast as possible.`;
  } else if (reason === "grace_expired") {
    el.innerHTML = `<strong> Your ${graceH}-hour free period has ended — payment required.</strong> ` +
      `${noun} hidden until your <strong>${fee}/month</strong> subscription is paid.` + renewViaAdmin;
  } else {
    const when = sub && sub.paid_until ? ` on ${sub.paid_until}` : "";
    el.innerHTML = `<strong> Subscription expired${when}.</strong> ${noun} hidden from clients until it's renewed. ` +
      `The <strong>${fee}/month</strong> subscription is paid to the admin, who extends it.` + renewViaAdmin;
  }
};

// =====================================================
// Shared demand-spec chips — what the seeker actually wants, at a glance
// =====================================================
// A request reaches the agent with a full spec. Rendered as one grey sentence
// it's easy to skim past and call the wrong person. This turns a demand row
// into SCANNABLE chips so the agent reads the call-or-skip criteria instantly:
//   • HARD constraints (the agent must be able to meet these or the call is
//     wasted) — listing kind, property type, budget ceiling, bedrooms — shown
//     as emphasised coloured chips;
//   • SOFT preferences (confirm on the call) — furnished, self-contained,
//     bathrooms, payment plan — as muted chips;
//   • MUST-HAVE amenities (✔) and what to AVOID (⛔) — as their own lines.
// The hard chips come from real columns; the rest is parsed out of the `note`
// this app writes (request-place.js buildSpecNote), so no schema change.
//   const html = window.pawaDemandSpec(row);   // → chip HTML string
window.pawaDemandSpec = (r) => {
  const esc = window.escHtml || ((s) => String(s == null ? "" : s)
    .replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));
  const T = (k) => (window.t ? window.t(k) : k);
  const fmtTzs = (p) => {
    p = Number(p) || 0;
    if (p >= 1e9) return (p / 1e9).toFixed(p % 1e9 ? 1 : 0) + "B";
    if (p >= 1e6) return (p / 1e6).toFixed(p % 1e6 ? 1 : 0) + "M";
    if (p >= 1e3) return Math.round(p / 1e3) + "k";
    return p ? String(p) : "";
  };
  if (!document.getElementById("pdsStyles")) {
    const s = document.createElement("style");
    s.id = "pdsStyles";
    s.textContent = `
      .pds{display:flex;flex-wrap:wrap;gap:5px;align-items:center;margin-top:5px}
      .pds-c{font-size:.72rem;font-weight:700;padding:2px 8px;border-radius:999px;background:#eef2f0;color:#41504a;white-space:nowrap}
      .pds-c.k{background:#e6efff;color:#1d4ed8}
      .pds-c.t{background:#ede9fe;color:#6d28d9}
      .pds-c.b{background:#dff3e8;color:#0a6f4d}
      .pds-c.s{background:#f1f5f3;color:#52605a;font-weight:600}
      .pds-line{flex-basis:100%;font-size:.72rem;font-weight:700;padding:2px 8px;border-radius:8px;line-height:1.35}
      .pds-must{background:#e7f5ee;color:#0a6f4d}
      .pds-avoid{background:#fdecea;color:#b3261e}`;
    document.head.appendChild(s);
  }

  // Parse the note this app wrote: "A · B · must have: X, Y · avoid/notes: Z".
  let must = "", avoid = "";
  const soft = [];
  String(r.note || "").split(" · ").map((s) => s.trim()).filter(Boolean).forEach((seg) => {
    const lc = seg.toLowerCase();
    if (lc.startsWith("must have:")) must = seg.slice(seg.indexOf(":") + 1).trim();
    else if (lc.startsWith("avoid/notes:") || lc.startsWith("avoid:") || lc.startsWith("notes:")) avoid = seg.slice(seg.indexOf(":") + 1).trim();
    else if (seg !== "Typed request") soft.push(seg);
  });

  const chips = [];
  chips.push(`<span class="pds-c k">${r.listing === "sale" ? T("rp_listing_buy") : T("rp_listing_rent")}</span>`);
  if (r.type) chips.push(`<span class="pds-c t">${esc(r.type)}</span>`);
  if (Number(r.max_budget_tzs) > 0) chips.push(`<span class="pds-c b">≤ ${esc(fmtTzs(r.max_budget_tzs))} TZS</span>`);
  if (Number(r.min_bedrooms) > 0) chips.push(`<span class="pds-c">${esc(String(r.min_bedrooms))}+ ${T("ds_bed")}</span>`);
  if (r.needed_from) chips.push(`<span class="pds-c s">${T("ds_from")} ${esc(String(r.needed_from).slice(0, 10))}</span>`);
  if (r.distance_m != null) chips.push(`<span class="pds-c s">${r.distance_m < 1000 ? r.distance_m + " m" : (r.distance_m / 1000).toFixed(1) + " km"} ${T("ds_away")}</span>`);
  const typeLc = String(r.type || "").toLowerCase();
  soft.filter((s) => s.toLowerCase() !== typeLc)
    .forEach((s) => chips.push(`<span class="pds-c s">${esc(s)}</span>`));
  if (must) chips.push(`<span class="pds-line pds-must">✔ ${T("rp_must_label")}: ${esc(must)}</span>`);
  if (avoid) chips.push(`<span class="pds-line pds-avoid">⛔ ${T("ds_avoid")}: ${esc(avoid)}</span>`);
  return `<div class="pds">${chips.join("")}</div>`;
};

// =====================================================
// Agent awareness — "your client list is your business"
// =====================================================
// Shown once (then snoozed) on every agent dashboard. Teaches agents that the
// contacts they capture (phone + what the customer wants + their dates) are the
// asset that grows their income: instant matches, repeat business, beating
// deadlines, and never losing a deal to a lost number. Dismissible; re-appears
// after RESHOW_DAYS so the habit keeps getting reinforced.
//   opts: { mount, id?, kind?: "houses"|"services"|"trucks", captureHint? }
window.renderAgentClientTip = (opts) => {
  opts = opts || {};
  const mount = opts.mount;
  if (!mount) return;
  const id = opts.id || "agentClientTip";
  const kind = opts.kind || "houses";
  const RESHOW_DAYS = 14;
  const KEY = "pawa.agentClientTip.dismissedAt." + kind;

  // Respect a recent dismissal.
  try {
    const at = +localStorage.getItem(KEY) || 0;
    if (at && (Date.now() - at) < RESHOW_DAYS * 86400000) { document.getElementById(id)?.remove(); return; }
  } catch (_) {}
  if (document.getElementById(id)) return;   // already on screen

  const item = kind === "trucks" ? "truck job" : kind === "services" ? "service request" : "room";
  const captureHint = opts.captureHint ||
    (kind === "houses"
      ? "Save every caller's phone, what they want, their budget and their move-in dates — use the <strong>Tenant</strong> button to log renters and keep the <strong>waiting-renters</strong> board full."
      : "Save every caller's phone, what they need, their budget and their dates.");
  const beatLine = kind === "houses"
    ? " — even before a tenant's rent ends"
    : "";

  const el = document.createElement("div");
  el.id = id;
  el.style.cssText = "margin:0 0 16px;border:1px solid #e3d3a6;border-radius:14px;overflow:hidden;" +
    "background:linear-gradient(180deg,#fffaf0,#ffffff);box-shadow:0 1px 3px rgba(0,0,0,.05);";
  el.innerHTML =
    '<div style="display:flex;gap:12px;padding:14px 16px;align-items:flex-start;font-family:inherit;">' +
      '<div style="font-size:1.5rem;line-height:1;flex-shrink:0;">💼</div>' +
      '<div style="flex:1;min-width:0;">' +
        '<div style="font-weight:800;color:#7a5a10;font-size:1rem;margin:0 0 3px;">Your client list is your business</div>' +
        '<p style="margin:0 0 8px;font-size:.88rem;line-height:1.5;color:#5b5036;">' + captureHint +
          ' The contacts you keep today are the deals you close tomorrow — this is the single most valuable asset you build here.</p>' +
        '<ul style="margin:0;padding-left:18px;font-size:.84rem;line-height:1.6;color:#5b5036;">' +
          '<li><strong>Instant matches</strong> — when a new ' + item + ' comes up you already have customers waiting, so you call them first and close before anyone else.</li>' +
          '<li><strong>Repeat &amp; referrals</strong> — a client you served well comes back and sends their friends.</li>' +
          '<li><strong>Beat deadlines</strong> — knowing each customer’s dates lets you line up the next deal early' + beatLine + '.</li>' +
          '<li><strong>Never lose income</strong> — a saved number is a deal you can still close; a lost number is money gone.</li>' +
        '</ul>' +
        '<button type="button" id="' + id + 'Dismiss" style="margin-top:10px;background:#7a5a10;color:#fff;border:0;' +
          'border-radius:9px;padding:8px 16px;font-weight:600;font-size:.85rem;cursor:pointer;">Got it</button>' +
      '</div>' +
    '</div>';

  // Sit at the top of the dashboard. The subscription paywall (if any) inserts at
  // firstChild too and may mount after this — that's fine, it lands above the tip.
  mount.insertBefore(el, mount.firstChild);
  document.getElementById(id + "Dismiss")?.addEventListener("click", () => {
    try { localStorage.setItem(KEY, String(Date.now())); } catch (_) {}
    el.remove();
  });
};

// =====================================================
// Agent awareness — "scout the Frame before you list"
// =====================================================
// One agent owns one Frame. Before listing, an agent should read the area as a
// room for business: the magnets that gather people, the roads/nodes that carry
// them, the daily rhythm, and where demand beats supply. This card surfaces the
// Frame tool at the listing moment. Dismissible; re-appears after RESHOW_DAYS.
//   opts: { mount, id?, kind?: "houses"|"services"|"trucks" }
window.renderFrameScout = (opts) => {
  opts = opts || {};
  const mount = opts.mount;
  if (!mount) return;
  const id = opts.id || "agentFrameScout";
  const kind = opts.kind || "houses";
  const RESHOW_DAYS = 21;
  const KEY = "pawa.frameScout.dismissedAt." + kind;

  try {
    const at = +localStorage.getItem(KEY) || 0;
    if (at && (Date.now() - at) < RESHOW_DAYS * 86400000) { document.getElementById(id)?.remove(); return; }
  } catch (_) {}
  if (document.getElementById(id)) return;

  const lead = kind === "trucks" ? "moving routes" : kind === "services" ? "service" : "rooms";
  const el = document.createElement("div");
  el.id = id;
  el.style.cssText = "margin:0 0 16px;border:1px solid #c9bdf0;border-radius:14px;overflow:hidden;" +
    "background:linear-gradient(135deg,#f4f1ff,#ffffff);box-shadow:0 1px 3px rgba(0,0,0,.05);";
  el.innerHTML =
    '<div style="display:flex;gap:12px;padding:14px 16px;align-items:flex-start;font-family:inherit;">' +
      '<div aria-hidden="true" style="flex-shrink:0;width:34px;height:34px;border-radius:10px;background:rgba(99,60,214,.12);display:grid;place-items:center;">' +
        '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#5326c0" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 3v18"/></svg>' +
      '</div>' +
      '<div style="flex:1;min-width:0;">' +
        '<div style="font-weight:800;color:#3f2aa0;font-size:1rem;margin:0 0 3px;">Scout the area first - read its Frame</div>' +
        '<p style="margin:0 0 8px;font-size:.88rem;line-height:1.5;color:#4a4368;">A Frame reads any area as a <strong>room for business</strong>: who gathers there, the roads and nodes that carry them, the daily rhythm, and where demand beats supply. Pick the right Frame for your ' + lead + ', then own it.</p>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
          '<a href="frame.html" style="background:#5326c0;color:#fff;border:0;border-radius:9px;padding:8px 16px;font-weight:700;font-size:.85rem;text-decoration:none;">Open the Frame</a>' +
          '<button type="button" id="' + id + 'Dismiss" style="background:transparent;color:#5326c0;border:1px solid #c9bdf0;border-radius:9px;padding:8px 14px;font-weight:600;font-size:.85rem;cursor:pointer;">Maybe later</button>' +
        '</div>' +
      '</div>' +
    '</div>';

  mount.insertBefore(el, mount.firstChild);
  document.getElementById(id + "Dismiss")?.addEventListener("click", () => {
    try { localStorage.setItem(KEY, String(Date.now())); } catch (_) {}
    el.remove();
  });
};

// =====================================================
// SMS fallback — reach phone-only / offline agents
// =====================================================
// Best-effort: POSTs to the send-sms Edge Function (which holds the Africa's
// Talking / Twilio secrets and verifies the caller is an admin). Passes the
// signed-in admin's token so the function can authorise. Degrades silently to
// { configured:false } if the function isn't deployed yet (404), so the in-app
// message still works without it.  to: string | string[]
window.pawaSendSms = async (to, message) => {
  const cfg = window.APP_CONFIG || {};
  const base = (cfg.SUPABASE_URL || "").replace(/\/$/, "");
  const path = cfg.SEND_SMS_PATH || "/functions/v1/send-sms";
  const anon = cfg.SUPABASE_ANON_KEY || "";
  const list = (Array.isArray(to) ? to : [to]).map((s) => String(s || "").trim()).filter(Boolean);
  if (!base || !list.length || !message) return { configured: false, sent: 0 };
  let token = anon;
  try { const s = await window.Auth?.getSession?.(); if (s?.access_token) token = s.access_token; } catch (_) {}
  try {
    const res = await fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: anon, Authorization: "Bearer " + token },
      body: JSON.stringify({ to: list, message }),
    });
    if (res.status === 404) return { configured: false, sent: 0 };
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { configured: true, sent: 0, error: data.error || ("HTTP " + res.status) };
    return { configured: true, sent: data.sent ?? list.length, provider: data.provider };
  } catch (_) { return { configured: false, sent: 0 }; }
};

// =====================================================
// Agent inbox — messages the admin sent to this agent's account
// =====================================================
// Shows the agent any UNREAD messages the admin sent them (individually, or as
// part of "everyone unpaid / deactivated"). Dismissing one marks it read so it
// won't show again. Silently no-ops if the agent_messages table isn't installed
// or the agent has no messages. Call from every agent dashboard.
//   opts: { sb?, mount }
window.renderAgentMessages = async (opts) => {
  opts = opts || {};
  const sb = opts.sb || (window.DataStore && window.DataStore.sb);
  const mount = opts.mount;
  if (!sb || !mount) return;

  let rows = [];
  try {
    const { data, error } = await sb.from("agent_messages")
      .select("id,body,created_at")
      .is("read_at", null)
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) return;            // table missing / no access → silently skip
    rows = Array.isArray(data) ? data : [];
  } catch (_) { return; }

  const id = "agentMsgInbox";
  document.getElementById(id)?.remove();
  if (!rows.length) return;

  const esc = window.escHtml || ((s) => String(s == null ? "" : s)
    .replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));

  const el = document.createElement("div");
  el.id = id;
  el.style.cssText = "margin:0 0 16px;display:flex;flex-direction:column;gap:10px";
  el.innerHTML = rows.map((m) => {
    let when = "";
    try { when = " · " + new Date(m.created_at).toLocaleDateString(undefined, { day: "numeric", month: "short" }); } catch (_) {}
    const body = esc(m.body).replace(/\n/g, "<br>");
    return `<div class="agent-msg" data-id="${esc(m.id)}" style="position:relative;border:1px solid #bfdbfe;background:linear-gradient(180deg,#eff6ff,#fff);border-radius:13px;padding:13px 16px;box-shadow:0 1px 3px rgba(0,0,0,.05)">
      <button type="button" class="agent-msg-x" aria-label="Dismiss" style="position:absolute;top:8px;right:11px;border:0;background:none;font-size:19px;line-height:1;color:#1e40af;cursor:pointer;opacity:.6">×</button>
      <div style="font-weight:800;color:#1e40af;font-size:.86rem;margin:0 18px 4px 0">Message from Pawa admin${when}</div>
      <div style="font-size:.9rem;line-height:1.5;color:#1e293b">${body}</div>
    </div>`;
  }).join("");
  mount.insertBefore(el, mount.firstChild);

  el.querySelectorAll(".agent-msg-x").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const card = btn.closest(".agent-msg");
      const mid = card && card.dataset.id;
      card?.remove();
      if (!el.querySelector(".agent-msg")) el.remove();
      if (mid) { try { await sb.from("agent_messages").update({ read_at: new Date().toISOString() }).eq("id", mid); } catch (_) {} }
      window.refreshAgentMsgBadge?.();   // keep the nav count in sync
    });
  });
};

// Unread-message count badge in the shared nav (Account menu) + a dot on the
// mobile hamburger, so an agent notices a new admin message immediately on any
// page. Scoped to the signed-in user (eq to_user_id), so an admin's own badge
// stays at their own count, not everyone's. Called from nav.js once logged in.
window.refreshAgentMsgBadge = async () => {
  const badge = document.getElementById("navMsgBadge");
  const dot = document.getElementById("navMsgDot");
  const mdot = document.getElementById("mnavMsgDot");
  if (!badge && !dot && !mdot) return;

  if (!document.getElementById("navMsgBadgeStyles")) {
    const st = document.createElement("style");
    st.id = "navMsgBadgeStyles";
    st.textContent =
      ".nav-msg-badge{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;margin:0 3px;border-radius:999px;background:#e11d48;color:#fff;font-size:.68rem;font-weight:800;line-height:1;vertical-align:middle}" +
      ".nav-msg-badge[hidden]{display:none}" +
      ".nav-toggle{position:relative}" +
      ".nav-msg-dot{position:absolute;top:3px;right:3px;width:9px;height:9px;border-radius:50%;background:#e11d48;border:1.5px solid #fff}" +
      ".nav-msg-dot[hidden]{display:none}";
    (document.head || document.documentElement).appendChild(st);
  }

  let n = 0;
  const sb = window.DataStore && window.DataStore.sb;
  if (sb) {
    let uid = null;
    try { const s = await window.Auth?.getSession?.(); uid = s?.user?.id || null; } catch (_) {}
    if (uid) {
      try {
        const { count, error } = await sb.from("agent_messages")
          .select("id", { count: "exact", head: true })
          .eq("to_user_id", uid).is("read_at", null);
        if (!error && typeof count === "number") n = count;
      } catch (_) {}
    }
  }

  if (badge) {
    if (n > 0) { badge.textContent = n > 99 ? "99+" : String(n); badge.hidden = false; }
    else { badge.hidden = true; badge.textContent = ""; }
  }
  if (dot) dot.hidden = n <= 0;
  if (mdot) mdot.hidden = n <= 0;
};

// =====================================================
// Agent subscription renewal — ADMIN-ONLY
// =====================================================
// Renewals are no longer self-serve: an agent pays the admin (cash / mobile
// money / however), and the admin records it in the All Agents tab where the
// amount paid determines how long the subscription runs. So this entry point
// just directs the agent to the admin. The legacy mobile-money flow below is
// disabled (kept unreachable for reference / possible future re-enable).
window.openAgentSubscribeModal = async (opts) => {
  const contact = (window.adminContactHtml && window.adminContactHtml()) || "Please contact the Pawa admin.";
  // Strip the HTML tags for a plain-text alert.
  const plain = contact.replace(/<[^>]+>/g, "");
  alert("Renewals are handled by the admin.\n\nPay the admin to extend your subscription and they'll activate it right away.\n\n" + plain);
  return;
  /* --- disabled: legacy self-serve mobile-money flow (unreachable) --------- */
  opts = opts || {};
  const cfg = window.APP_CONFIG || {};
  const sb  = (window.DataStore && window.DataStore.sb) || window.SB;
  const base = (cfg.SUPABASE_URL || "").replace(/\/$/, "");
  const anon = cfg.SUPABASE_ANON_KEY || "";
  if (!sb || !base) { alert("Payments aren't configured on this site yet."); return; }

  const feeTzs = cfg.AGENT_MONTHLY_FEE_TZS || 10000;
  const feeStr = window.formatTZS ? window.formatTZS(feeTzs) : ("TZS " + feeTzs.toLocaleString("en-US"));
  const esc = window.escHtml || ((s) => String(s == null ? "" : s)
    .replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));

  // Resolve the agent_key from the RPC when the caller didn't pass one.
  let agentKey = opts.agentKey || null;
  if (!agentKey) {
    try {
      const { data } = await sb.rpc("my_agent_subscription");
      const s = Array.isArray(data) ? data[0] : data;
      agentKey = s && s.agent_key;
    } catch (_) {}
  }
  if (!agentKey) { alert("Please sign in as an agent first."); return; }

  // Mobile-money methods this site has enabled.
  const LABELS = { mpesa: "M-Pesa (Vodacom)", tigopesa: "Mixx by Yas (Tigo Pesa)",
    airtel: "Airtel Money", halopesa: "HaloPesa", azampesa: "Azam Pesa" };
  const methods = (cfg.PAYMENT_METHODS_ENABLED || []).filter((m) => LABELS[m]);
  if (!methods.length) methods.push("mpesa");

  const ov = document.createElement("div");
  ov.setAttribute("role", "dialog"); ov.setAttribute("aria-modal", "true");
  ov.style.cssText = "position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(2,6,23,.62);padding:20px";
  ov.innerHTML =
    '<div style="background:#fff;color:#0f172a;max-width:400px;width:100%;border-radius:16px;padding:22px;box-shadow:0 20px 60px rgba(0,0,0,.35);font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif">' +
      '<h2 style="margin:0 0 4px;font-size:1.15rem">Pay your subscription</h2>' +
      '<p style="margin:0 0 14px;color:#475569">Keep your listings live for one month — <strong>' + esc(feeStr) + '</strong>. Pay by mobile money; approve the prompt on your phone.</p>' +
      '<label style="display:block;font-weight:600;margin:0 0 4px">Pay with</label>' +
      '<select id="_asMethod" style="width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid #cbd5e1;border-radius:10px;font-size:1rem;margin-bottom:10px">' +
        methods.map((m) => '<option value="' + m + '">' + esc(LABELS[m]) + '</option>').join("") +
      '</select>' +
      '<label style="display:block;font-weight:600;margin:0 0 4px">Phone to charge</label>' +
      '<input id="_asPhone" type="tel" inputmode="tel" autocomplete="tel" placeholder="+255 7XX XXX XXX" style="width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid #cbd5e1;border-radius:10px;font-size:1rem;margin-bottom:10px" />' +
      '<div id="_asMsg" style="min-height:18px;color:#b91c1c;font-size:.86rem;margin:0 0 8px"></div>' +
      '<button id="_asPay" style="width:100%;padding:12px;border:0;border-radius:10px;background:#0a6f4d;color:#fff;font-weight:700;font-size:1rem;cursor:pointer">Pay ' + esc(feeStr) + '</button>' +
      '<button id="_asCancel" style="width:100%;margin-top:8px;padding:9px;border:0;border-radius:10px;background:none;color:#64748b;font-size:.92rem;cursor:pointer">Cancel</button>' +
    '</div>';
  document.body.appendChild(ov);
  const $ = (id) => ov.querySelector(id);
  const methodEl = $("#_asMethod"), phoneEl = $("#_asPhone"), msgEl = $("#_asMsg"),
        payEl = $("#_asPay"), cancelEl = $("#_asCancel");
  setTimeout(() => { try { phoneEl.focus(); } catch (_) {} }, 30);
  const close = () => { try { ov.remove(); } catch (_) {} };
  const setMsg = (t, ok) => { msgEl.style.color = ok ? "#15803d" : "#b91c1c"; msgEl.innerHTML = t || ""; };
  cancelEl.addEventListener("click", close);
  ov.addEventListener("click", (e) => { if (e.target === ov) close(); });

  // After initiating, poll the RPC until the trigger has extended coverage.
  async function confirmPaid() {
    for (let i = 0; i < 24; i++) {
      try {
        const { data } = await sb.rpc("my_agent_subscription");
        const s = Array.isArray(data) ? data[0] : data;
        if (s && (s.reason === "active" || (s.active === true && s.paid_until))) return true;
      } catch (_) {}
      await new Promise((r) => setTimeout(r, 5000));
    }
    return false;
  }

  payEl.addEventListener("click", async () => {
    const method = methodEl.value;
    const phone = (phoneEl.value || "").trim();
    if (phone.replace(/\D/g, "").length < 9) { setMsg("Enter a valid phone number."); return; }
    payEl.disabled = true; payEl.textContent = "Sending prompt…"; setMsg("");
    try {
      const res = await fetch(base + "/functions/v1/create-payment", {
        method: "POST",
        headers: { "Content-Type": "application/json", "apikey": anon, "Authorization": "Bearer " + anon },
        body: JSON.stringify({
          reference: agentKey + "|" + Date.now().toString(36),
          reference_type: "agent_subscription",
          amount_tzs: feeTzs,
          method, phone,
          description: "Pawa agent monthly subscription",
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ("Payment failed (" + res.status + ")"));
      setMsg(data.status === "completed"
        ? "Payment received — activating…"
        : "Approve the prompt on <strong>" + esc(phone) + "</strong>. Waiting for confirmation…", true);
      const ok = await confirmPaid();
      if (ok) {
        setMsg("Subscription active! Reloading…", true);
        setTimeout(() => location.reload(), 1200);
      } else {
        setMsg("We haven't seen the payment yet. If you approved it, give it a moment and reload — your listings will reactivate automatically.");
        payEl.disabled = false; payEl.textContent = "Pay " + feeStr;
      }
    } catch (err) {
      setMsg((err && err.message) || "Could not start the payment — try again.");
      payEl.disabled = false; payEl.textContent = "Pay " + feeStr;
    }
  });
};

// =====================================================
// Shared map base layer — satellite + street names (hybrid)
// =====================================================
// Adds a Google-Maps-Hybrid-style base to a Leaflet map: satellite imagery
// with road + place-name labels on top, so every map across the app shows
// streets *and* aerial context. Uses Mapbox satellite-streets when a public
// token is set (APP_CONFIG.MAPBOX_TOKEN); otherwise free Esri World Imagery
// + Esri reference overlays (transport + boundaries/places) — no key needed.
window.addSatelliteHybrid = (map, { maxZoom = 19 } = {}) => {
  if (!window.L || !map) return;
  const token = window.APP_CONFIG?.MAPBOX_TOKEN || "";
  let satellite, street;

  if (token) {
    satellite = L.tileLayer(
      `https://api.mapbox.com/styles/v1/mapbox/satellite-streets-v12/tiles/512/{z}/{x}/{y}?access_token=${token}`,
      { maxZoom: 22, tileSize: 512, zoomOffset: -1, attribution: "© Mapbox © OpenStreetMap" });
    street = L.tileLayer(
      `https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/512/{z}/{x}/{y}?access_token=${token}`,
      { maxZoom: 22, tileSize: 512, zoomOffset: -1, attribution: "© Mapbox © OpenStreetMap" });
  } else {
    // Satellite hybrid = free Esri imagery + transport + boundaries/places refs
    // + Carto Voyager street-name labels (Esri's place layer alone misses many
    // street names). Grouped so the layer switcher toggles them as one base.
    satellite = L.layerGroup([
      L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        { maxZoom, attribution: "Tiles © Esri, Maxar, Earthstar Geographics" }),
      L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}",
        { maxZoom }),
      L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
        { maxZoom }),
      L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}{r}.png",
        { maxZoom, subdomains: "abcd", opacity: 1, attribution: "© CARTO" }),
    ]);
    // Plain street map = Carto Voyager (crisp road + place names, no imagery).
    street = L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
      { maxZoom, subdomains: "abcd", attribution: "© CARTO © OpenStreetMap contributors" });
  }

  satellite.addTo(map);  // default view = satellite hybrid (unchanged)
  // Toggle so users can flip to a plain street map when they want crisp names.
  L.control.layers(
    { " Satellite": satellite, " Map": street },
    null,
    { position: "topright", collapsed: false }
  ).addTo(map);
};

// =====================================================
// Shared MapLibre (GL) hybrid base — same idea as addSatelliteHybrid above,
// for the pages that use maplibregl instead of Leaflet (houses directory,
// house detail, agent pin-picker). Satellite imagery + Esri road overlay +
// Carto street-name labels, plus a hidden crisp street basemap behind a
// one-tap " Map ⇄  Satellite" toggle so roads and street names are
// always readable.
//   style:  new maplibregl.Map({ style: pawaGlHybridStyle(), … })
//   toggle: map.addControl(pawaGlBasemapToggle(), "top-right")
window.pawaGlHybridStyle = ({ maxzoom = 19, labelMinzoom = 9 } = {}) => ({
  version: 8,
  sources: {
    esri: { type: "raster",
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
      tileSize: 256, maxzoom,
      attribution: "Tiles © Esri, Maxar, Earthstar Geographics" },
    // Road lines + highway shields drawn over the imagery.
    esri_transport: { type: "raster",
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}"],
      tileSize: 256, maxzoom },
    // Street + place-name labels (Esri's transport layer alone misses many).
    carto_labels: { type: "raster",
      tiles: [
        "https://a.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}.png",
        "https://b.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}.png",
        "https://c.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}.png",
        "https://d.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}.png"
      ],
      tileSize: 256, maxzoom,
      attribution: "© CARTO © OpenStreetMap contributors" },
    // Crisp street basemap for the toggle (roads + names, no imagery).
    carto_base: { type: "raster",
      tiles: [
        "https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
        "https://b.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
        "https://c.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
        "https://d.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png"
      ],
      tileSize: 256, maxzoom,
      attribution: "© CARTO © OpenStreetMap contributors" }
  },
  layers: [
    { id: "carto_base",     type: "raster", source: "carto_base", layout: { visibility: "none" } },
    { id: "esri",           type: "raster", source: "esri" },
    { id: "esri_transport", type: "raster", source: "esri_transport" },
    { id: "carto_labels",   type: "raster", source: "carto_labels", minzoom: labelMinzoom }
  ]
});

window.pawaGlBasemapToggle = () => ({
  onAdd(map) {
    const wrap = document.createElement("div");
    wrap.className = "maplibregl-ctrl maplibregl-ctrl-group";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.style.cssText = "width:auto;padding:0 10px;font:600 12px/30px system-ui,sans-serif;";
    let sat = true;
    btn.textContent = " Map";
    btn.title = "Switch between satellite and street map";
    btn.addEventListener("click", () => {
      sat = !sat;
      const set = (id, vis) => { if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", vis); };
      set("esri",           sat ? "visible" : "none");
      set("esri_transport", sat ? "visible" : "none");
      set("carto_labels",   sat ? "visible" : "none");
      set("carto_base",     sat ? "none" : "visible");
      btn.textContent = sat ? " Map" : " Satellite";
    });
    wrap.appendChild(btn);
    this._wrap = wrap;
    return wrap;
  },
  onRemove() { this._wrap?.remove(); }
});
