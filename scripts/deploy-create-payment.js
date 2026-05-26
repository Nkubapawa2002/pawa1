// =====================================================================
// Deploy edge functions (create-payment + payment-callback) via the
// Supabase Management API's /functions/deploy endpoint, including their
// shared dependencies. No bundling required.
//
// Usage:
//   SUPABASE_PAT=sbp_... node scripts/deploy-create-payment.js
//   SUPABASE_PAT=sbp_... node scripts/deploy-create-payment.js payment-callback
//   SUPABASE_PAT=sbp_... node scripts/deploy-create-payment.js --all
//
// Env to set in Supabase Dashboard → Edge Functions → secrets AFTER first
// deploy (the function still runs in demo mode without them):
//   PRIMARY_PROVIDER       — selcom | clickpesa | azampay | flutterwave | demo
//   SELCOM_API_KEY, SELCOM_API_SECRET, SELCOM_VENDOR
//   CLICKPESA_CLIENT_ID, CLICKPESA_API_KEY, CLICKPESA_WEBHOOK_SECRET
//   AZAMPAY_TOKEN  OR  AZAMPAY_CLIENT_ID + AZAMPAY_CLIENT_SECRET + AZAMPAY_APP_NAME
//   FLW_SECRET_KEY, FLW_HASH
// =====================================================================

const fs   = require("node:fs");
const path = require("node:path");

const PROJECT_REF = "kkdpacoiwntrcukgwksh";
const PAT = process.env.SUPABASE_PAT;
if (!PAT) { console.error("SUPABASE_PAT not set"); process.exit(1); }

const FN_ROOT = path.join(__dirname, "..", "supabase", "functions");

// Shared files all payment functions need. Uploaded under ../_shared/
const SHARED_FILES = [
  "cors.ts", "providers.ts", "demo.ts",
  "selcom.ts", "clickpesa.ts", "azampay.ts", "flutterwave.ts",
  "registry.ts",
];

async function deployFunction(slug) {
  const fd = new FormData();
  fd.append("metadata", JSON.stringify({
    entrypoint_path: "index.ts",
    verify_jwt: false,             // browser/aggregator calls don't carry JWT
    name: slug,
  }));

  const entry = path.join(FN_ROOT, slug, "index.ts");
  if (!fs.existsSync(entry)) {
    console.error(`Missing entrypoint: ${entry}`);
    process.exit(1);
  }

  fd.append("file", new Blob([fs.readFileSync(entry)], { type: "application/typescript" }), "index.ts");
  for (const name of SHARED_FILES) {
    const abs = path.join(FN_ROOT, "_shared", name);
    fd.append("file",
      new Blob([fs.readFileSync(abs)], { type: "application/typescript" }),
      "../_shared/" + name);
  }

  const url = `https://api.supabase.com/v1/projects/${PROJECT_REF}/functions/deploy?slug=${slug}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${PAT}` },
    body: fd,
  });
  const text = await res.text();
  console.log(`\n=== ${slug} ===`);
  console.log("HTTP " + res.status);
  console.log(text.slice(0, 600));
  return res.ok;
}

(async () => {
  const arg = process.argv[2];
  let slugs;
  if (!arg || arg === "create-payment") slugs = ["create-payment"];
  else if (arg === "--all")              slugs = ["create-payment","payment-callback"];
  else                                   slugs = [arg];

  let allOk = true;
  for (const slug of slugs) {
    const ok = await deployFunction(slug);
    if (!ok) allOk = false;
  }
  if (!allOk) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
