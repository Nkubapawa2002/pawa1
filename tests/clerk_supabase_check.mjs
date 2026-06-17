// Clerk + Supabase integration checker.
// Verifies the wiring described in docs/CLERK_SETUP.md without a browser:
//  1. config.js consistency (USE_CLERK, PK decodes to CLERK_DOMAIN)
//  2. Clerk Frontend API reachable + healthy (environment + JWKS)
//  3. Supabase reachable + anon RLS works
//  4. Supabase accepts a Clerk-issued JWT (third-party auth configured)
// Run: node tests/clerk_supabase_check.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const log = (s) => console.log(s);
const ok = (s) => log("  \x1b[32mPASS\x1b[0m " + s);
const bad = (s) => log("  \x1b[31mFAIL\x1b[0m " + s);
const warn = (s) => log("  \x1b[33mWARN\x1b[0m " + s);
let failures = 0;
const fail = (s) => { failures++; bad(s); };

// ---- Load config.js by evaluating it in a fake window ----
function loadConfig() {
  const src = fs.readFileSync(path.join(root, "js", "config.js"), "utf8");
  const window = {};
  // config.js touches document/Analytics at the bottom; stub them.
  const document = { createElement: () => ({ setAttribute() {}, addEventListener() {} }),
    head: { appendChild() {} }, documentElement: { appendChild() {} } };
  const fn = new Function("window", "document", src + "\nreturn window;");
  return fn(window, document);
}

async function getJSON(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, json, text };
}

async function main() {
  log("\n=== Clerk  Supabase integration check ===\n");
  const w = loadConfig();
  const cfg = w.APP_CONFIG;

  // 1. Config consistency
  log("[1] config.js");
  const PK = cfg.CLERK_PUBLISHABLE_KEY || "";
  const DOMAIN = cfg.CLERK_DOMAIN || "";
  log(`      USE_CLERK = ${cfg.USE_CLERK}`);
  if (!PK || !DOMAIN) { fail("CLERK_PUBLISHABLE_KEY / CLERK_DOMAIN not both set"); }
  else {
    const b64 = PK.replace(/^pk_(test|live)_/, "");
    let decoded = "";
    try { decoded = Buffer.from(b64, "base64").toString().replace(/\$$/, ""); } catch (_) {}
    if (decoded === DOMAIN) ok(`publishable key decodes to CLERK_DOMAIN (${DOMAIN})`);
    else fail(`PK decodes to "${decoded}" but CLERK_DOMAIN is "${DOMAIN}"`);
  }
  const enabled = !!(cfg.USE_CLERK && PK && DOMAIN);
  if (cfg.USE_CLERK && enabled) ok("Clerk would be ENABLED at runtime");
  else warn("Clerk is OFF at runtime (USE_CLERK false) — app uses Supabase Auth");

  // 2. Clerk Frontend API
  log("\n[2] Clerk Frontend API (https://" + DOMAIN + ")");
  let jwksOk = false;
  try {
    const env = await getJSON(`https://${DOMAIN}/v1/environment?__clerk_api_version=2024-10-01&_clerk_js_version=5`);
    if (env.status === 200 && env.json) ok(`/v1/environment 200 (instance live, ${env.json?.auth_config ? "auth_config present" : "ok"})`);
    else fail(`/v1/environment returned ${env.status}`);
  } catch (e) { fail("environment fetch threw: " + e.message); }
  try {
    const jwks = await getJSON(`https://${DOMAIN}/.well-known/jwks.json`);
    if (jwks.status === 200 && jwks.json?.keys?.length) { ok(`JWKS has ${jwks.json.keys.length} key(s)`); jwksOk = true; }
    else fail(`JWKS returned ${jwks.status} / no keys`);
  } catch (e) { fail("JWKS fetch threw: " + e.message); }

  // 3. Supabase reachable + anon RLS
  log("\n[3] Supabase (" + cfg.SUPABASE_URL + ")");
  const SB = cfg.SUPABASE_URL, ANON = cfg.SUPABASE_ANON_KEY;
  try {
    const r = await getJSON(`${SB}/rest/v1/houses?select=id&limit=1`, { headers: { apikey: ANON, Authorization: "Bearer " + ANON } });
    if (r.status === 200) ok(`anon read on houses 200 (RLS public read works, ${Array.isArray(r.json) ? r.json.length : "?"} rows)`);
    else fail(`anon read on houses returned ${r.status}: ${r.text.slice(0, 200)}`);
  } catch (e) { fail("Supabase anon read threw: " + e.message); }

  // 4. Is Clerk registered as Supabase's third-party auth provider?
  //    NOTE: a fake/unsigned token can't prove this (Supabase reports "no
  //    suitable key" for a bad signature, which is indistinguishable from
  //    "issuer unknown"). Two reliable checks instead:
  //      • If SBP_TOKEN (Management API PAT) is set → query the provider list
  //        + its resolved JWKS (definitive, no browser needed).
  //      • Otherwise → skip with a pointer to the live end-to-end test, which
  //        mints a REAL Clerk token (needs the Clerk secret key).
  log("\n[4] Supabase third-party (Clerk) provider registration");
  const SBP = process.env.SBP_TOKEN;
  if (!SBP) {
    warn("set SBP_TOKEN (Supabase Mgmt API PAT) to verify here, OR run the live");
    log("       end-to-end test: CK_SECRET=sk_... node tests/_clerk_backend_e2e.mjs");
  } else {
    try {
      const ref = SB.replace(/^https?:\/\//, "").split(".")[0];
      const r = await getJSON(`https://api.supabase.com/v1/projects/${ref}/config/auth/third-party-auth`,
        { headers: { Authorization: "Bearer " + SBP } });
      const providers = Array.isArray(r.json) ? r.json : [];
      const clerk = providers.find((p) => (p.oidc_issuer_url || "").includes(DOMAIN));
      if (!clerk) fail(`No third-party provider registered for ${DOMAIN}. Add it (dashboard or Mgmt API).`);
      else {
        ok(`provider registered (type=${clerk.type}, issuer=${clerk.oidc_issuer_url})`);
        const keys = clerk.resolved_jwks?.keys?.length || 0;
        if (keys > 0) ok(`Supabase resolved Clerk's JWKS (${keys} key) → tokens will verify`);
        else fail("provider registered but JWKS NOT resolved — check the Clerk domain");
      }
    } catch (e) { fail("Mgmt API check threw: " + e.message); }
  }

  log("\n=== " + (failures ? `\x1b[31m${failures} failure(s)\x1b[0m` : "\x1b[32mall checks passed\x1b[0m") + " ===\n");
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
