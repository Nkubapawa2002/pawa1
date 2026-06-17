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

  // ---- locate --------------------------------------------------------
  // AI-assisted geocode for a free-text place description. Uses ai-map to
  // refine the description (landmark, "behind X", vague area) into a clean
  // place + region, then the browser geocoder (window.pawaGeo) to resolve
  // coordinates. Degrades to a plain geocode when AI is unavailable, so the
  // caller always gets a best-effort pin.
  // AI.locate(query, { regions? }) → { lat, lng, label, region, answer } | null
  async function locate(query, opts = {}) {
    query = (query || "").trim();
    if (!query) return null;
    let geoQuery = query, region = null, answer = null;
    try {
      const r = await map({ query, regions: opts.regions });
      const intent = r && r.intent;
      if (intent) {
        answer = intent.answer || null;
        region = intent.region || null;
        const name = (intent.from && intent.from.name) || (intent.to && intent.to.name) || null;
        if (name) geoQuery = (region && !name.includes(region)) ? `${name}, ${region}` : name;
        else if (region) geoQuery = region;
      }
    } catch (_) { /* AI off/unreachable → geocode the raw text */ }
    const geo = window.pawaGeo;
    if (!geo || !geo.suggest) return null;
    const tryGeo = async (q) => {
      try {
        const hits = await geo.suggest(q, { limit: 5 });
        const hit = (hits || []).find((h) => Number.isFinite(h.lat) && Number.isFinite(h.lng));
        return hit ? { lat: hit.lat, lng: hit.lng, label: hit.name, region, answer } : null;
      } catch (_) { return null; }
    };
    return (await tryGeo(geoQuery)) || (geoQuery !== query ? await tryGeo(query) : null);
  }

  window.AI = { chat, think, map, locate };
})();
