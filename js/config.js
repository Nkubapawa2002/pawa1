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

  // Emails allowed to log into admin.html (must also exist in `admins` table for RLS).
  ADMIN_EMAILS: ["pawa4761@gmail.com"],

  // ---------- n8n Automation ----------
  // Base URL of your n8n instance (no trailing slash).
  // All webhook calls from the dashboard go to: N8N_WEBHOOK_BASE + /webhook/...
  N8N_WEBHOOK_BASE: "https://your-n8n.yourdomain.com",

  // ---------- Anthropic AI Chat ----------
  // Claude is now the brain of the voice + chat agent, but the API key
  // does NOT live in the browser. It is configured in:
  //   • VAPI assistant → Provider Keys → Anthropic   (for voice calls)
  //   • n8n env → ANTHROPIC_API_KEY                  (if any workflow needs it)
  // The values below are kept only so chat.js's legacy demoReply fallback
  // still loads without errors. Leave ANTHROPIC_API_KEY empty.
  ANTHROPIC_API_KEY: "",                            // do not set — server-side only
  ANTHROPIC_MODEL: "claude-opus-4-7",               // pinned to match VAPI config
  ANTHROPIC_API_URL: "https://api.anthropic.com/v1/messages",

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
