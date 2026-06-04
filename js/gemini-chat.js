// =============================================================
// Pawa AI — Gemini text chat client (secure proxy)
// Calls the Supabase Edge Function `gemini-chat`, which holds the
// GEMINI_API_KEY server-side and runs the model-fallback chain. The
// browser never sees the key.
//
// Exposes: window.GeminiChat.chat({ system, messages, models?,
//                                   maxTokens?, temperature? })
//          → resolves to the reply string.
// =============================================================

(function () {
  const cfg     = () => window.APP_CONFIG || {};
  const baseUrl = () => (cfg().SUPABASE_URL || "").replace(/\/$/, "");
  const anon    = () => cfg().SUPABASE_ANON_KEY || "";
  const endpoint = () => baseUrl() + (cfg().GEMINI_CHAT_PATH || "/functions/v1/gemini-chat");

  // True when the proxy is reachable (Supabase configured). Lets callers
  // skip straight to their fallback when it isn't.
  function available() {
    return !!baseUrl() && !!anon();
  }

  // messages: [{ role: "user" | "assistant", content: "…" }, …]
  async function chat({ system, messages, models, maxTokens = 1024, temperature = 0.6 }) {
    if (!available()) throw new Error("Gemini proxy not configured");

    const res = await fetch(endpoint(), {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "apikey":        anon(),
        "Authorization": "Bearer " + anon(),
      },
      body: JSON.stringify({
        messages,
        system,
        models,
        max_tokens:  maxTokens,
        temperature,
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || data?.detail || `gemini-chat ${res.status}`);
    }
    const reply = (data?.reply || "").trim();
    if (!reply) throw new Error("Gemini returned an empty reply");
    return reply;
  }

  window.GeminiChat = { chat, available };
})();
