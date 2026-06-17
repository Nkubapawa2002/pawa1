// Definitive Clerk -> Supabase end-to-end test via Clerk BACKEND API.
// Creates a test user, mints a real session token, checks Supabase REST/RLS
// accepts it, then deletes the test user. Secret via env: CK_SECRET.
const CK = "https://api.clerk.com/v1";
const SECRET = process.env.CK_SECRET;
const REF = "kkdpacoiwntrcukgwksh";
const SBURL = `https://${REF}.supabase.co`;
const ANON = "sb_publishable_qDfG71jBmWEG-JA_Xdh2MA_m6krC_8o";

async function ck(method, path, body) {
  const res = await fetch(CK + path, { method,
    headers: { Authorization: "Bearer " + SECRET, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined });
  const t = await res.text(); let j = null; try { j = JSON.parse(t); } catch (_) {}
  return { status: res.status, json: j, text: t };
}
const decode = (jwt) => { try { return JSON.parse(Buffer.from(jwt.split(".")[1], "base64").toString()); } catch { return {}; } };

let userId = null, sessionId = null;
async function main() {
  const email = `pawa_e2e_${Date.now()}@example.com`;
  // 1. Create user (server-side, bypasses bot protection).
  let u = await ck("POST", "/users", {
    email_address: [email], password: "E2e-Passw0rd-2026!xZ",
    skip_password_checks: true, skip_legal_checks: true,
  });
  console.log("[1] create user:", u.status, u.json?.id || JSON.stringify(u.json?.errors || u.text).slice(0, 220));
  userId = u.json?.id;
  if (!userId) return console.log("FAIL: user not created");

  // 2. Create a session for that user.
  let s = await ck("POST", "/sessions", { user_id: userId });
  console.log("[2] create session:", s.status, s.json?.id || JSON.stringify(s.json?.errors || s.text).slice(0, 220));
  sessionId = s.json?.id;
  if (!sessionId) return console.log("FAIL: session not created");

  // 3. Mint the default session token (the one the browser would send).
  let t = await ck("POST", `/sessions/${sessionId}/tokens`, {});
  let jwt = t.json?.jwt;
  console.log("[3] mint token:", t.status, jwt ? "JWT acquired" : JSON.stringify(t.json?.errors || t.text).slice(0, 220));
  if (!jwt) return console.log("FAIL: no token");
  let claims = decode(jwt);
  console.log("    default-token claims: iss=" + claims.iss + " sub=" + claims.sub + " role=" + (claims.role || "(none)") + " aud=" + (claims.aud || "(none)"));

  // 4. Probe Supabase REST with the default token (READ).
  await probe("default session token", jwt);

  // 4a. INSERT a house as this Clerk user (owner_user_id = Clerk sub), then delete.
  const sub = claims.sub;
  const ins = await fetch(`${SBURL}/rest/v1/houses`, {
    method: "POST",
    headers: { apikey: ANON, Authorization: "Bearer " + jwt, "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify({ id: "e2e_" + Date.now(), owner_user_id: sub, title: "E2E test listing", type: "apartment", listing: "rent" }),
  });
  const insText = await ins.text();
  console.log(`    -> INSERT house as Clerk user: ${ins.status} ${ins.status < 300 ? "\x1b[32mOK \x1b[0m" : "\x1b[31m " + insText.slice(0,160) + "\x1b[0m"}`);
  if (ins.status < 300) {
    let id = null; try { id = JSON.parse(insText)[0]?.id; } catch (_) {}
    if (id) {
      const del = await fetch(`${SBURL}/rest/v1/houses?id=eq.${id}`, { method: "DELETE", headers: { apikey: ANON, Authorization: "Bearer " + jwt } });
      console.log(`    -> DELETE own house: ${del.status} ${del.status < 300 ? "\x1b[32mOK \x1b[0m" : ""}`);
    }
  }

  // 4z. Sanity: anonymous read still works (existing Supabase-auth/public path).
  const anon = await fetch(`${SBURL}/rest/v1/houses?select=id&limit=1`, { headers: { apikey: ANON, Authorization: "Bearer " + ANON } });
  console.log(`    -> anon public read still works: ${anon.status} ${anon.status === 200 ? "\x1b[32mOK \x1b[0m" : ""}`);

  // 4b. If no role claim, also try the 'supabase' JWT template (older integration style).
  if (!claims.role) {
    let t2 = await ck("POST", `/sessions/${sessionId}/tokens/supabase`, {});
    if (t2.json?.jwt) {
      console.log("[4b] 'supabase' template token claims:", JSON.stringify(decode(t2.json.jwt)).slice(0, 200));
      await probe("'supabase' template token", t2.json.jwt);
    } else {
      console.log("[4b] no 'supabase' template configured (" + t2.status + ") — expected with native integration");
    }
  }
}

async function probe(label, jwt) {
  const res = await fetch(`${SBURL}/rest/v1/houses?select=id&limit=1`,
    { headers: { apikey: ANON, Authorization: "Bearer " + jwt } });
  const txt = await res.text();
  const verdict = res.status === 200 ? "\x1b[32mACCEPTED \x1b[0m" : "\x1b[31mREJECTED \x1b[0m";
  console.log(`    -> Supabase REST with ${label}: ${res.status} ${verdict} ${res.status === 200 ? "" : txt.slice(0, 160)}`);
}

main()
  .catch((e) => console.error("threw:", e))
  .finally(async () => {
    if (userId) { const d = await ck("DELETE", "/users/" + userId); console.log("[cleanup] delete user " + userId + ": " + d.status); }
  });
