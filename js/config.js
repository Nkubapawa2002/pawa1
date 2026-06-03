// =====================================================
// Pawa Bus Cargo - Configuration
// =====================================================
// IMPORTANT for production: never commit real keys to a public repo.
// For demo / static hosting, anon keys + Row-Level-Security policies are OK.

window.APP_CONFIG = {
  // ---------- Supabase ----------
  SUPABASE_URL: "https://kkdpacoiwntrcukgwksh.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_qDfG71jBmWEG-JA_Xdh2MA_m6krC_8o",

  // Public bucket names
  BUS_PHOTOS_BUCKET: "bus-photos",
  AGENT_PHOTOS_BUCKET: "agent-photos",

  // ---------- Map / geocoding gateway (services/go) ----------
  // Public URL of the Go map gateway that fronts OpenStreetMap/Nominatim
  // (rate-limited + cached + proper User-Agent). Leave empty to auto-use
  // http://127.0.0.1:8091 on localhost and fall back to calling Nominatim
  // directly everywhere else. Set this to your deployed gateway URL (no
  // trailing slash) to route all production traffic through it.
  GEO_GATEWAY_URL: "https://pawa-map-gateway.onrender.com",

  // ---------- Video faststart gateway (services/python) ----------
  // Public URL of the Python service that remuxes uploaded house videos to MP4
  // "faststart" (moov atom to the front) so they stream without stutter. The
  // houses uploader POSTs each clip here before storing it, and silently falls
  // back to the original file if this is unset/unreachable. Leave empty to
  // auto-use http://127.0.0.1:8094 on localhost. Set to your deployed URL (no
  // trailing slash) to enable it in production.
  VIDEO_GATEWAY_URL: "https://pawa-video-gateway.onrender.com",

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
  // Master switch for the AI search brain (houses smart-search + ride trip box).
  // Leave FALSE until you've set the Anthropic key and deployed the function:
  //   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
  //   supabase functions deploy ai-search
  // Then flip to true. Everything works without it (regex parser fallback).
  AI_SEARCH_ENABLED: false,
  // Optional full-URL override for ai-search (e.g. a self-hosted Python server
  // at services/python). Setting this auto-enables AI regardless of the flag
  // above — handy for local testing. Leave empty to use SUPABASE_URL + path.
  AI_SEARCH_URL: "",

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

  // ---------- Maps / Weather ----------
  // Leaflet uses OpenStreetMap (no key needed).
  // Open-Meteo provides current conditions (no key needed).
  // Mapbox satellite tiles need a public `pk.` token. Don't commit it to
  // this file — GitHub's secret scanner will block the push. Instead, put
  // it in `js/config.local.js` (gitignored) as:
  //   window.APP_CONFIG.MAPBOX_TOKEN = "pk....";
  // The meet / ride / track pages read it from APP_CONFIG at runtime.
  MAPBOX_TOKEN: "",

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

  // ---------- Currency ----------
  CURRENCY: "TZS"
};

// Format a number as TZS currency
window.formatTZS = (n) => {
  if (n == null || isNaN(n)) return "TZS 0";
  return "TZS " + Number(n).toLocaleString("en-US");
};
