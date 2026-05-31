// =====================================================================
// POST /functions/v1/ai-map
// Natural-language map query. Converts a free-text question like
// "nearest agent to Mwanza" or "show buses going Dar -> Arusha tonight"
// into structured map intent the frontend can render on Leaflet.
//
// Body: {
//   query:  string                   // required, NL question
//   origin?: { lat:number, lng:number }   // optional user location
//   regions?: string[]               // optional region whitelist
//   model?: string                   // default: claude-sonnet-4-6
// }
//
// Response: {
//   ok: true,
//   intent: {
//     kind: "find_nearest" | "route" | "list_in_region" | "show_point" | "unknown",
//     from?: { name?: string, lat?: number, lng?: number },
//     to?:   { name?: string, lat?: number, lng?: number },
//     region?: string,
//     entity?: "agent" | "bus" | "shipment" | "ride" | "stop" | "place",
//     filters?: object,
//     answer: string                 // human-readable summary in user's lang
//   },
//   raw, model, usage
// }
// =====================================================================

import { corsHeaders, json } from "../_shared/cors.ts";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_TOKENS = 800;

const SYSTEM_PROMPT = `You are the map query parser for Pawa, a Tanzania bus cargo and passenger ticketing app. Convert the user's natural-language question into a structured map intent.

Always respond with a single JSON object, no prose. Shape:
{
  "kind": "find_nearest" | "route" | "list_in_region" | "show_point" | "unknown",
  "from": { "name": string|null, "lat": number|null, "lng": number|null } | null,
  "to":   { "name": string|null, "lat": number|null, "lng": number|null } | null,
  "region": string|null,
  "entity": "agent" | "bus" | "shipment" | "ride" | "stop" | "place" | null,
  "filters": object,
  "answer": string
}

Rules:
- Use Tanzanian region names exactly as written by the user (Dar es Salaam, Mwanza, Arusha, Dodoma, Mbeya, Tanga, Morogoro, Kigoma, Tabora, Iringa, Mtwara, Lindi, Songea, Sumbawanga, Bukoba, Musoma, Singida, Shinyanga, Kahama, Geita, Manyara, Njombe, Katavi, Simiyu, Rukwa, Pwani).
- Only fill lat/lng when the user gave them explicitly. Never guess coordinates — leave them null and let the frontend geocode by name.
- "answer" is a short sentence in the same language as the query (Swahili or English).
- If the question is not a map query, set kind="unknown" and explain briefly in "answer".`;

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
    userMsg.push(`User location: ${body.origin.lat}, ${body.origin.lng}`);
  }
  if (Array.isArray(body.regions) && body.regions.length) {
    userMsg.push(`Allowed regions: ${body.regions.join(", ")}`);
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
    intent = { kind: "unknown", from: null, to: null, region: null, entity: null, filters: {}, answer: raw || "Could not parse query." };
  }

  return json({
    ok: true,
    intent,
    raw,
    model: data?.model || model,
    usage: data?.usage || null,
  });
});
