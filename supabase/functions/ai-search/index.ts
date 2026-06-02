// =====================================================================
// POST /functions/v1/ai-search
//
// The AI brain for ALL search on Pawa — houses (rent/sale), rides
// ("near me", pickup/dropoff), and generic "find X near me" queries.
// It turns a free-text question in English OR Swahili into a single
// structured intent the frontend's existing engines already understand:
//
//   • house criteria → identical shape to js/houses.js parseSmartQuery()
//     so the WASM ranker (js/house-match.js) consumes it unchanged.
//   • ride intent     → pickup / dropoff / vehicle for js/ride.js.
//   • place / nearMe  → what to anchor the map on (geocoded by the
//     frontend; we never invent coordinates).
//
// The KEY NEVER LEAVES THE SERVER. Set it once with:
//   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
// Until then the frontend silently uses its built-in regex parser, so
// the site keeps working with zero AI — this endpoint is purely additive.
//
// Body: {
//   query:   string                      // required — the NL question
//   origin?: { lat:number, lng:number }  // optional device GPS (for "near me")
//   areas?:  string[]                     // optional known area list (houses)
//   vehicleTypes?: string[]               // optional ride vehicle whitelist
//   lang?:   "en" | "sw"                  // optional UI language hint
//   model?:  string                       // default below
// }
//
// Response: { ok:true, intent:{…}, raw, model, usage }
// See SCHEMA below for the exact intent shape (the frontend mirrors it).
// =====================================================================

import { corsHeaders, json } from "../_shared/cors.ts";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_TOKENS = 700;

// The intent contract. Keep this in lockstep with js/ai-search.js and the
// Python self-host server (services/python/main.py).
const SYSTEM_PROMPT = `You are the search-intent parser for Pawa, a Tanzania (TZ) housing + ride-hailing app used in English and Swahili. Convert the user's free-text request into ONE JSON object. Output the JSON only — no prose, no code fences.

Shape (always return every key; use null / [] when not stated):
{
  "domain": "house" | "ride" | "unknown",
  "answer": string,                       // ONE short friendly sentence, in the SAME language as the query
  "nearMe": boolean,                      // true if they referenced their own current location ("near me", "karibu nami", "around here")
  "place": { "name": string } | null,     // a landmark/area to centre on ("near Mwenge", "karibu na UDSM"); name only, do NOT invent coordinates
  "house": {
    "listing": "rent" | "sale" | null,
    "type": "apartment" | "house" | "plot" | "office" | null,
    "bedrooms": number | null,            // integer; "studio" => 0
    "bathrooms": number | null,
    "area": string | null,                // a TZ neighbourhood/suburb name if named
    "priceMax": number | null,            // budget CEILING in TZS, fully expanded (e.g. "500k" => 500000, "1.2m" => 1200000)
    "priceMin": number | null,            // budget FLOOR in TZS
    "amenities": string[],                // e.g. ["parking","water","security","wifi","furnished"]
    "keywords": string[]                  // free descriptors e.g. ["sea view","modern","gated"]
  },
  "ride": {
    "vehicleType": string | null,         // e.g. "bajaji","bodaboda","car","taxi" — match the provided whitelist when given
    "pickup":  { "name": string } | null, // name only; null + nearMe=true means "use my GPS as pickup"
    "dropoff": { "name": string } | null,
    "when": string | null                 // "now","tonight","8pm" etc. as the user said it
  }
}

Rules:
- Decide "domain": a place to live/rent/buy => "house"; getting a car/bajaji/bodaboda or going somewhere => "ride"; if unclear => "unknown".
- TZS money: expand shorthand to full integers. "500k"=500000, "1m"/"1 mil"=1000000, "1.5m"=1500000, "2bn"=2000000000. "under/below/up to/within" => priceMax. "over/from/at least" => priceMin. A bare budget like "700k" with no word => priceMax.
- Never output coordinates. Put only the spoken name in place/pickup/dropoff; the app geocodes it (TZ-only).
- If they say "near me" / "karibu nami" / "nearby" with no named place, set nearMe=true and place=null (and for rides, pickup=null meaning use GPS).
- Prefer area names exactly as the user wrote them. If an "areas" whitelist is supplied, snap to the closest matching entry; otherwise keep their wording.
- For rides, snap vehicleType to the supplied "vehicleTypes" whitelist when one is given.
- "answer" is one short sentence confirming what you understood, in the user's language (Swahili if the query is Swahili).
- If the request is neither housing nor a ride, set domain="unknown" and briefly say so in "answer".`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")    return json({ error: "method_not_allowed" }, 405);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "anthropic_key_missing" }, 500);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }

  const query = typeof body?.query === "string" ? body.query.trim() : "";
  if (!query) return json({ error: "query_required" }, 400);

  const model = typeof body.model === "string" ? body.model : DEFAULT_MODEL;

  const userMsg: string[] = [`Query: ${query}`];
  if (body.origin && Number.isFinite(body.origin.lat) && Number.isFinite(body.origin.lng)) {
    userMsg.push(`User current location (lat,lng): ${body.origin.lat}, ${body.origin.lng}`);
  }
  if (Array.isArray(body.areas) && body.areas.length) {
    userMsg.push(`Known areas (snap to one when relevant): ${body.areas.slice(0, 200).join(", ")}`);
  }
  if (Array.isArray(body.vehicleTypes) && body.vehicleTypes.length) {
    userMsg.push(`Ride vehicle types: ${body.vehicleTypes.join(", ")}`);
  }
  if (body.lang === "sw" || body.lang === "en") {
    userMsg.push(`UI language: ${body.lang}`);
  }

  const payload = {
    model,
    max_tokens: DEFAULT_MAX_TOKENS,
    temperature: 0.1,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: userMsg.join("\n") }],
  };

  let res: Response;
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return json({ error: "anthropic_unreachable", detail: String(e) }, 502);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) return json({ error: "anthropic_error", status: res.status, detail: data }, res.status);

  const raw = (data?.content || [])
    .filter((b: any) => b?.type === "text")
    .map((b: any) => b.text)
    .join("\n")
    .trim();

  let intent: any = null;
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try { intent = JSON.parse(jsonMatch[0]); } catch { intent = null; }
  }
  if (!intent) {
    intent = {
      domain: "unknown", answer: raw || "Could not understand the request.",
      nearMe: false, place: null,
      house: { listing: null, type: null, bedrooms: null, bathrooms: null, area: null,
               priceMax: null, priceMin: null, amenities: [], keywords: [] },
      ride: { vehicleType: null, pickup: null, dropoff: null, when: null },
    };
  }

  return json({
    ok: true,
    intent,
    raw,
    model: data?.model || model,
    usage: data?.usage || null,
  });
});
