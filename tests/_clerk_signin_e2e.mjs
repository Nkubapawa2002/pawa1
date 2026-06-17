// Client-Trust sign-in flow (mirrors ClerkAuth.signIn) end-to-end via the
// Frontend API with a +clerk_test user (dev code 424242). Run in its OWN
// process. Secret via env: CK_SECRET.
const CK = "https://api.clerk.com/v1", S = process.env.CK_SECRET;
const DOMAIN = "discrete-prawn-57.clerk.accounts.dev", FAPI = "https://" + DOMAIN + "/v1";
const SBURL = "https://kkdpacoiwntrcukgwksh.supabase.co";
const ANON = "sb_publishable_qDfG71jBmWEG-JA_Xdh2MA_m6krC_8o";
const ck = (m, p, b) => fetch(CK + p, { method: m, headers: { Authorization: "Bearer " + S, "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined }).then(async r => ({ s: r.status, j: await r.json().catch(() => null) }));
let dbjwt = null;
async function fapi(p, { method = "GET", form = null } = {}) {
  let url = FAPI + p + (p.includes("?") ? "&" : "?") + "_clerk_js_version=5.0.0";
  if (dbjwt) url += "&__clerk_db_jwt=" + dbjwt;
  const o = { method, headers: {} };
  if (form) { o.headers["Content-Type"] = "application/x-www-form-urlencoded"; o.body = new URLSearchParams(form).toString(); }
  const r = await fetch(url, o); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {}
  return { s: r.status, j, t };
}
let fails = 0;
const check = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) fails++; };

async function main() {
  const email = "signin_" + Date.now() + "+clerk_test@example.com", pass = "Signin-Test-2026!x";
  const u = await ck("POST", "/users", { email_address: [email], password: pass, skip_legal_checks: true });
  if (!u.j?.id) { console.log("could not create test user", u.s); process.exit(2); }
  try {
    const db = await fapi("/dev_browser", { method: "POST" }); dbjwt = db.j && (db.j.token || db.j.id);
    await fapi("/environment"); await fapi("/client");
    let si = await fapi("/client/sign_ins", { method: "POST", form: { identifier: email, password: pass, strategy: "password" } });
    let r = si.j && si.j.response;
    check(r && (r.status === "needs_client_trust" || r.status === "complete"), "[signin] create → " + (r && r.status));
    if (r && r.status === "needs_client_trust") {
      const f = (r.supported_second_factors || []).find(x => x.strategy === "email_code");
      await fapi("/client/sign_ins/" + r.id + "/prepare_second_factor", { method: "POST", form: f && f.email_address_id ? { strategy: "email_code", email_address_id: f.email_address_id } : { strategy: "email_code" } });
      const att = await fapi("/client/sign_ins/" + r.id + "/attempt_second_factor", { method: "POST", form: { strategy: "email_code", code: "424242" } });
      r = att.j && att.j.response;
      check(r && r.status === "complete", "[signin] attempt code → complete" + (!(r && r.status === "complete") && att.j?.errors ? " " + JSON.stringify(att.j.errors).slice(0, 140) : ""));
    }
    if (r && r.created_session_id) {
      const tok = await fapi("/client/sessions/" + r.created_session_id + "/tokens/supabase", { method: "POST" });
      const jwt = tok.j?.jwt;
      const ok = !!jwt && (await fetch(SBURL + "/rest/v1/houses?select=id&limit=1", { headers: { apikey: ANON, Authorization: "Bearer " + jwt } })).status === 200;
      check(ok, "[signin] Supabase accepts the session token");
    }
  } finally { await ck("DELETE", "/users/" + u.j.id); }
  console.log(fails ? `\n${fails} failure(s)` : "\nsign-in (Client Trust) flow OK");
  process.exit(fails ? 1 : 0);
}
main().catch(e => { console.error("threw:", e); process.exit(2); });
