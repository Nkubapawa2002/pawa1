// ============================================================================
//  AI search client  —  window.AISearch
//
//  Thin browser bridge to the `ai-search` Supabase Edge Function (which holds
//  the Anthropic key server-side). It turns a natural-language question, in
//  English or Swahili, into structured search intent for:
//     • houses  — same criteria shape as houses.js parseSmartQuery(), so it is
//                 a DROP-IN upgrade for the regex parser + WASM ranker.
//     • rides   — pickup / dropoff / vehicle for ride.js.
//     • near-me — what the map should anchor on.
//
//  Design guarantees (so the site never depends on AI being available):
//    1. If no endpoint is configured, or the key isn't set, or the call fails
//       / times out, every method resolves to null. Callers fall back to their
//       existing regex parsing. The page keeps working with zero AI.
//    2. The Anthropic key is NEVER referenced here — only the Edge Function URL.
//
//  "Just add the key": once you run
//       supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
//  and deploy the function, this lights up automatically. No frontend change.
// ============================================================================

(function () {
  const C = window.APP_CONFIG || {};
  const TIMEOUT_MS = 9000;

  // Resolve the ai-search endpoint. Priority:
  //   1. APP_CONFIG.AI_SEARCH_URL  (full absolute URL override)
  //   2. SUPABASE_URL + AI_SEARCH_PATH  (the normal deployed Edge Function)
  // Returns "" when nothing is configured → AI disabled, callers fall back.
  function endpoint() {
    if (C.AI_SEARCH_URL) return C.AI_SEARCH_URL;
    if (C.SUPABASE_URL && C.AI_SEARCH_PATH) return C.SUPABASE_URL.replace(/\/+$/, "") + C.AI_SEARCH_PATH;
    return "";
  }

  // Is the AI brain wired up AND switched on? An explicit AI_SEARCH_URL
  // override (self-host / local testing) counts as intentional enable; the
  // deployed Edge Function path additionally needs AI_SEARCH_ENABLED=true so
  // nothing AI-facing shows in production before the key is set + deployed.
  function configured() {
    if (!endpoint()) return false;
    if (C.AI_SEARCH_URL) return true;
    return C.AI_SEARCH_ENABLED === true;
  }

  // Per-session memo so we stop hitting a dead/unconfigured endpoint after the
  // first failure (e.g. key not set yet → 500). Cleared on full reload.
  let disabledForSession = false;

  function authHeaders() {
    const h = { "Content-Type": "application/json" };
    // Supabase Edge Functions sit behind the gateway; the anon key authorises
    // the request the same way the rest of the app's function calls do.
    if (C.SUPABASE_ANON_KEY) {
      h["Authorization"] = "Bearer " + C.SUPABASE_ANON_KEY;
      h["apikey"] = C.SUPABASE_ANON_KEY;
    }
    return h;
  }

  async function callRaw(query, ctx = {}) {
    const url = endpoint();
    if (!url || disabledForSession) return null;
    const q = (query || "").trim();
    if (!q) return null;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: authHeaders(),
        signal: ac.signal,
        body: JSON.stringify({
          query: q,
          origin: ctx.origin || null,
          areas: ctx.areas || null,
          vehicleTypes: ctx.vehicleTypes || null,
          lang: ctx.lang || (window.getLang && window.getLang()) || null,
          model: ctx.model || null,
        }),
      });
      if (!res.ok) {
        // 500 = key missing / not deployed yet → don't keep retrying this session.
        if (res.status === 500 || res.status === 404) disabledForSession = true;
        return null;
      }
      const data = await res.json().catch(() => null);
      return data && data.ok && data.intent ? data.intent : null;
    } catch (_) {
      return null;   // network / abort / timeout → silent fall back
    } finally {
      clearTimeout(timer);
    }
  }

  // Normalise the model's house object into the EXACT shape houses.js expects
  // from parseSmartQuery(): { listing, type, bedrooms, bathrooms, area,
  // priceMax, priceMin, amenities[], keywords[] }. Defensive about nulls/types.
  function toHouseCriteria(intent) {
    const h = (intent && intent.house) || {};
    const int = (v) => (v == null || v === "" || isNaN(+v)) ? null : Math.round(+v);
    const arr = (v) => Array.isArray(v) ? v.filter(x => typeof x === "string" && x.trim()).map(x => x.trim().toLowerCase()) : [];
    const oneOf = (v, set) => (typeof v === "string" && set.includes(v)) ? v : null;
    return {
      listing:  oneOf(h.listing, ["rent", "sale"]),
      type:     oneOf(h.type, ["apartment", "house", "plot", "office"]),
      bedrooms: int(h.bedrooms),
      bathrooms: int(h.bathrooms),
      area:     (typeof h.area === "string" && h.area.trim()) ? h.area.trim() : null,
      priceMax: int(h.priceMax),
      priceMin: int(h.priceMin),
      amenities: arr(h.amenities),
      keywords:  arr(h.keywords),
    };
  }

  // The landmark phrase the map should anchor on, if any:
  //   { name } from intent.place, or "__me__" when nearMe is set.
  function anchorFrom(intent) {
    if (!intent) return null;
    if (intent.place && typeof intent.place.name === "string" && intent.place.name.trim())
      return { name: intent.place.name.trim() };
    if (intent.nearMe) return { name: "__me__" };
    return null;
  }

  window.AISearch = {
    // Is the AI endpoint configured at all? (Doesn't prove the key is set.)
    configured,
    // True only after a confirmed-good round trip would be possible; callers
    // generally just await parseHouse/parseRide and check for null instead.
    available() { return configured() && !disabledForSession; },

    // Full raw intent ({domain, answer, nearMe, place, house, ride}) or null.
    async intent(query, ctx) { return callRaw(query, ctx); },

    // House search → { criteria, anchor, answer, domain } or null on fallback.
    //   criteria : drop-in for parseSmartQuery()
    //   anchor   : { name } place to geocode, { name:"__me__" } for GPS, or null
    async parseHouse(query, ctx) {
      const intent = await callRaw(query, ctx);
      if (!intent) return null;
      return {
        domain: intent.domain || "house",
        criteria: toHouseCriteria(intent),
        anchor: anchorFrom(intent),
        answer: typeof intent.answer === "string" ? intent.answer : "",
      };
    },

    // Ride search → { vehicleType, pickup, dropoff, when, nearMe, answer } or null.
    async parseRide(query, ctx) {
      const intent = await callRaw(query, ctx);
      if (!intent) return null;
      const r = intent.ride || {};
      const place = (p) => (p && typeof p.name === "string" && p.name.trim()) ? { name: p.name.trim() } : null;
      return {
        domain: intent.domain || "ride",
        vehicleType: typeof r.vehicleType === "string" ? r.vehicleType : null,
        pickup: place(r.pickup),
        dropoff: place(r.dropoff),
        when: typeof r.when === "string" ? r.when : null,
        nearMe: !!intent.nearMe,
        answer: typeof intent.answer === "string" ? intent.answer : "",
      };
    },
  };
})();
