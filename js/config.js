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
  USE_CLERK: true,
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
  // Every agent (bus/cargo, house owner, truck owner) pays this monthly fee.
  // New agents must pay within AGENT_GRACE_HOURS of registering or their account
  // auto-pauses (listings hidden) until the admin records a payment. Enforced in
  // supabase/agent_grace_active.sql; these mirror it for the UI copy + countdown.
  AGENT_MONTHLY_FEE_TZS: 10000,
  AGENT_GRACE_HOURS: 48,
  // New agents are live immediately but must be APPROVED by an admin within this
  // many days of registering, or their listings auto-hide until approved.
  // Enforced in supabase/agent_approval.sql; mirrored here for the UI copy.
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
// Renders the right notice from a my_agent_subscription() result:
//   • grace          → amber warning + live "Xh Ym left" countdown (non-blocking)
//   • grace_expired  → red paywall: 48h free period ended, pay to activate
//   • deactivated    → red paywall: deactivated by admin, contact admin
//   • expired/cancelled/overdue → red paywall: subscription lapsed, renew
//   • active/none    → nothing (removes any prior banner)
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

  // Self-serve "Pay now" CTA (mobile money). Shown for billing-driven states —
  // NOT for an admin 'deactivated' hold (only the admin can lift that).
  const payBtn = `<div style="margin-top:10px"><button type="button" data-agent-pay style="display:inline-flex;align-items:center;gap:6px;background:#0a6f4d;color:#fff;border:none;border-radius:10px;padding:9px 16px;font-weight:700;font-size:.9rem;cursor:pointer">Pay now — ${fee}/month</button></div>`;
  // Wire the CTA once via delegation, so the live grace countdown (which
  // re-renders innerHTML) never loses the handler.
  if (!el._payWired) {
    el._payWired = true;
    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-agent-pay]")) {
        e.preventDefault();
        window.openAgentSubscribeModal &&
          window.openAgentSubscribeModal({ agentKey: (sub && sub.agent_key) || null });
      }
    });
  }

  // ---- Active: subtle status bar + proactive "Renew" (pay before expiry) ----
  if (reason === "active") {
    const pu = sub && sub.paid_until ? new Date(sub.paid_until) : null;
    const daysLeft = pu ? Math.ceil((pu - new Date()) / 86400000) : null;
    const soon = daysLeft != null && daysLeft <= 7;
    const untilStr = pu ? pu.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "";
    el.style.cssText = "margin:0 0 16px;padding:11px 16px;border-radius:12px;font-size:.9rem;line-height:1.5;" +
      "display:flex;align-items:center;gap:12px;flex-wrap:wrap;" +
      (soon ? "background:#fff7ed;border:1px solid #fdba74;color:#9a3412"
            : "background:#f0fdf4;border:1px solid #bbf7d0;color:#166534");
    const msg = soon
      ? `<span>Subscription ends in <strong>${daysLeft} day${daysLeft === 1 ? "" : "s"}</strong>${untilStr ? ` (${untilStr})` : ""} — renew to stay live.</span>`
      : `<span>Subscription active${untilStr ? ` until <strong>${untilStr}</strong>` : ""}.</span>`;
    const renew = `<button type="button" data-agent-pay style="margin-left:auto;display:inline-flex;align-items:center;gap:6px;` +
      `background:${soon ? "#bc5c00" : "#0a6f4d"};color:#fff;border:none;border-radius:10px;padding:8px 14px;` +
      `font-weight:700;font-size:.86rem;cursor:pointer;white-space:nowrap">Renew${soon ? " now" : ""} — ${fee}/month</button>`;
    el.innerHTML = msg + renew;
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
        `New agents must pay <strong>${fee}/month</strong> within ${graceH} hours of registering.${left} ` +
        window.adminContactHtml() + payBtn;
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
      `${noun} hidden until you pay <strong>${fee}/month</strong>. ${window.adminContactHtml()}` + payBtn;
  } else {
    const when = sub && sub.paid_until ? ` on ${sub.paid_until}` : "";
    el.innerHTML = `<strong> Subscription expired${when}.</strong> ${noun} hidden from clients until you renew. ` +
      `Pay <strong>${fee}/month</strong> to reactivate. ${window.adminContactHtml()}` + payBtn;
  }
};

// =====================================================
// Agent self-serve subscription — mobile-money "Pay now" modal
// =====================================================
// Charges the monthly fee through the existing create-payment rail with
// reference_type='agent_subscription'. The DB trigger (agent_subscription_selfpay.sql)
// extends agent_billing.paid_until by a month when the payment completes; we
// then poll my_agent_subscription() and reload so listings unhide automatically.
//   opts: { agentKey?: string }  (agentKey resolved from the RPC if omitted)
window.openAgentSubscribeModal = async (opts) => {
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
