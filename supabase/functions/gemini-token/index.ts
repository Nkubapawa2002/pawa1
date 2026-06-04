// =====================================================================
// POST /functions/v1/gemini-token
// Mints a short-lived EPHEMERAL token for the Gemini Live voice API so
// the browser can open a realtime voice session WITHOUT ever seeing the
// real GEMINI_API_KEY. The key lives only as an Edge Function secret.
//
// The browser (js/gemini-voice.js) calls this, gets { token }, then
// connects to Gemini Live using that token as its apiKey. The token is
// good for a few uses and expires in 30 minutes; new sessions must start
// within a short window, so a leaked token is near-useless.
//
// Response: { ok: true, token: "auth_tokens/…" }
// =====================================================================

import { corsHeaders, json } from "../_shared/cors.ts";

const TOKEN_URL = "https://generativelanguage.googleapis.com/v1alpha/auth_tokens";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")    return json({ error: "method_not_allowed" }, 405);

  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) return json({ error: "gemini_key_missing" }, 500);

  const now = Date.now();
  const body = {
    uses: 5,                                                       // a few (re)connects
    expireTime:           new Date(now + 30 * 60 * 1000).toISOString(), // token valid 30 min
    newSessionExpireTime: new Date(now +  2 * 60 * 1000).toISOString(), // must connect within 2 min
  };

  let res: Response;
  try {
    res = await fetch(`${TOKEN_URL}?key=${encodeURIComponent(apiKey)}`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
    });
  } catch (e) {
    return json({ error: "gemini_unreachable", detail: String(e) }, 502);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) return json({ error: "token_error", status: res.status, detail: data }, res.status);

  return json({ ok: true, token: data?.name });
});
