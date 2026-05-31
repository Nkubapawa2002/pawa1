// =====================================================================
// js/ai.js — thin client for the three Anthropic-backed Edge Functions.
// Exposes window.AI.{chat, think, map}. The API key lives only in
// Supabase secrets; this file only knows the public anon key + paths.
//
// Pages that want AI must load this AFTER js/config.js:
//   <script src="js/ai.js"></script>
// =====================================================================

(function () {
  const baseUrl = () => (window.APP_CONFIG?.SUPABASE_URL || "").replace(/\/$/, "");
  const anon    = () => window.APP_CONFIG?.SUPABASE_ANON_KEY || "";

  const endpoint = (key, fallback) => baseUrl() + (window.APP_CONFIG?.[key] || fallback);

  async function post(url, body) {
    if (!baseUrl()) throw new Error("SUPABASE_URL not configured");
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": anon(),
        "Authorization": "Bearer " + anon(),
      },
      body: JSON.stringify(body || {}),
    });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!res.ok) {
      const err = new Error(`${url.split("/").pop()} ${res.status}: ${data?.error || text.slice(0, 200)}`);
      err.status = res.status; err.detail = data;
      throw err;
    }
    return data;
  }

  // ---- chat ----------------------------------------------------------
  // AI.chat({ messages, system?, model?, max_tokens?, temperature? })
  // → { reply, model, usage }
  async function chat(opts) {
    const url = endpoint("AI_CHAT_PATH", "/functions/v1/ai-chat");
    return post(url, opts);
  }

  // ---- think ---------------------------------------------------------
  // AI.think({ task, context?, schema?, model?, thinking?, max_tokens? })
  // → { result, raw, model, usage, thinking_used }
  async function think(opts) {
    const url = endpoint("AI_THINK_PATH", "/functions/v1/ai-think");
    return post(url, opts);
  }

  // ---- map -----------------------------------------------------------
  // AI.map({ query, origin?, regions?, model? })
  // → { intent: { kind, from, to, region, entity, filters, answer }, ... }
  async function map(opts) {
    const url = endpoint("AI_MAP_PATH", "/functions/v1/ai-map");
    return post(url, opts);
  }

  window.AI = { chat, think, map };
})();
