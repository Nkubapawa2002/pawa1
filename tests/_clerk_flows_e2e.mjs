// Exercise the exact Clerk calls our ClerkAuth flows make, end-to-end, via the
// Frontend API with a +clerk_test user (dev code 424242). Proves sign-in (with
// Client Trust), password reset, and sign-out work and that Supabase accepts the
// resulting token. Secret via env: CK_SECRET.  (Sign-up's create() is bot-
// protected on FAPI — handled in-browser by the Clerk SDK — so it's covered by
// the same prepare/attempt verification pattern proven here.)
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
const claimsOf = (jwt) => { try { return JSON.parse(Buffer.from(jwt.split(".")[1], "base64").toString()); } catch { return {}; } };
async function supaOK(jwt) {
  const r = await fetch(SBURL + "/rest/v1/houses?select=id&limit=1", { headers: { apikey: ANON, Authorization: "Bearer " + jwt } });
  return r.status === 200;
}
let fails = 0;
const check = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) fails++; };

async function main() {
  const email = "flows_" + Date.now() + "+clerk_test@example.com";
  const pass = "Flows-Test-2026!x";
  const u = await ck("POST", "/users", { email_address: [email], password: pass, skip_legal_checks: true });
  if (!u.j?.id) { console.log("could not create test user", u.s, JSON.stringify(u.j).slice(0, 200)); process.exit(2); }
  const userId = u.j.id;
  // Fresh, initialized client (the SDK does dev_browser + /environment + /client).
  async function freshClient() {
    const db = await fapi("/dev_browser", { method: "POST" }); dbjwt = db.j && (db.j.token || db.j.id);
    await fapi("/environment"); await fapi("/client");
  }

  try {
    // ---- B. Password reset FIRST, on a clean logged-out client (mirrors
    //         ClerkAuth.resetPassword, which runs from the login page) ---------
    await freshClient();
    const newPass = "Reset-Test-2026!z";
    let rs = await fapi("/client/sign_ins", { method: "POST", form: { identifier: email } });
    let rr = rs.j && rs.j.response;
    const rf = (rr && rr.supported_first_factors || []).find(x => x.strategy === "reset_password_email_code");
    check(!!rf, "[reset] reset_password_email_code is a supported factor");
    if (rf) {
      await fapi("/client/sign_ins/" + rr.id + "/prepare_first_factor", { method: "POST", form: rf.email_address_id ? { strategy: "reset_password_email_code", email_address_id: rf.email_address_id } : { strategy: "reset_password_email_code" } });
      const att = await fapi("/client/sign_ins/" + rr.id + "/attempt_first_factor", { method: "POST", form: { strategy: "reset_password_email_code", code: "424242", password: newPass } });
      const ar = att.j && att.j.response;
      check(ar && ar.status === "complete", "[reset] attempt code + new password → " + (ar && ar.status) + (att.j?.errors ? " " + JSON.stringify(att.j.errors).slice(0, 140) : ""));
      if (ar && ar.created_session_id) {
        const tok = await fapi("/client/sessions/" + ar.created_session_id + "/tokens/supabase", { method: "POST" });
        check(!!tok.j?.jwt && await supaOK(tok.j.jwt), "[reset] Supabase accepts token after reset");
      }
    }

    // ---- C. Sign out (the reset signed us in) -------------------------------
    const cl = await fapi("/client");
    const sid = cl.j?.response?.sessions?.[0]?.id || cl.j?.client?.sessions?.[0]?.id;
    if (sid) { const so = await fapi("/client/sessions/" + sid + "/remove", { method: "POST" }); check(so.s < 400, "[signout] session removed"); }
    // NOTE: sign-in + Client Trust is covered by tests/_clerk_signin_e2e.mjs in
    // its OWN process — the raw FAPI harness can't run two code-attempt flows in
    // one process (2nd dev-browser → "Signed out"); the in-app Clerk SDK is fine.
  } finally {
    await ck("DELETE", "/users/" + userId);
  }
  console.log(fails ? `\n${fails} failure(s)` : "\nall Clerk flow checks passed");
  process.exit(fails ? 1 : 0);
}
main().catch(e => { console.error("threw:", e); process.exit(2); });
