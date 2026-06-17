// =====================================================================
// POST /functions/v1/ai-map
// Natural-language map query → structured map intent for Leaflet/MapLibre.
// e.g. "nearest agent to Mwanza", "show buses Dar -> Arusha tonight".
//
// Powered by Gemini (reuses the GEMINI_API_KEY secret that already powers
// gemini-chat). The key lives only as an Edge Function secret.
//
// Body: { query: string, origin?: {lat,lng}, regions?: string[], model?: string }
// Response: { ok:true, intent:{ kind, from, to, region, entity, filters, answer }, raw, model }
// =====================================================================

import { corsHeaders, json } from "../_shared/cors.ts";

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-flash-latest",
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite",
];

const SYSTEM_PROMPT = `You are the map query parser for Pawa, a Tanzania housing, services and transport app. Convert the user's natural-language question into a structured map intent.

Always respond with a single JSON object, no prose. Shape:
{
  "kind": "find_nearest" | "route" | "list_in_region" | "show_point" | "unknown",
  "from": { "name": string|null, "lat": number|null, "lng": number|null } | null,
  "to":   { "name": string|null, "lat": number|null, "lng": number|null } | null,
  "region": string|null,
  "entity": "agent" | "bus" | "shipment" | "ride" | "stop" | "place" | "house" | "truck" | "service" | null,
  "filters": object,
  "answer": string
}

Rules:
- Use Tanzanian region names exactly as written by the user (Dar es Salaam, Mwanza, Arusha, Dodoma, Mbeya, Tanga, Morogoro, Kigoma, Tabora, Iringa, Mtwara, Lindi, Songea, Sumbawanga, Bukoba, Musoma, Singida, Shinyanga, Kahama, Geita, Manyara, Njombe, Katavi, Simiyu, Rukwa, Pwani).
- For a single place/landmark to pin (e.g. "behind Mlimani City", "near UDSM gate", "Mikocheni B"), set kind="show_point" and put the cleanest searchable place name in "from".name. NEVER guess coordinates — leave lat/lng null and let the frontend geocode by name.
- "answer" is a short sentence in the same language as the query (Swahili or English).
- If the question is not a map query, set kind="unknown" and explain briefly in "answer".`;

async function geminiJson(apiKey: string, system: string, userText: string) {
  const payload = {
    contents: [{ role: "user", parts: [{ text: userText }] }],
    systemInstruction: { parts: [{ text: system }] },
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 800,
      responseMimeType: "application/json",
      thinkingConfig: { thinkingBudget: 0 },
    },
  };
  let lastErr = "gemini_unavailable";
  for (const model of MODELS) {
    let res: Response;
    try {
      res = await fetch(`${BASE}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
    } catch (e) { lastErr = String(e); continue; }
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      const text = (data?.candidates?.[0]?.content?.parts || []).map((p: any) => p.text || "").join("").trim();
      if (text) return { text, model };
      lastErr = "empty_reply"; continue;
    }
    lastErr = data?.error?.message || `gemini_${res.status}`;
    if (res.status === 429 || res.status === 503 || res.status === 404) continue;
    return { fatal: { detail: data, status: res.status } };
  }
  return { err: lastErr };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")    return json({ error: "method_not_allowed" }, 405);

  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) return json({ error: "gemini_key_missing" }, 500);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }

  const query = typeof body?.query === "string" ? body.query.trim() : "";
  if (!query) return json({ error: "query_required" }, 400);

  const userMsg: string[] = [`Query: ${query}`];
  if (body.origin && Number.isFinite(body.origin.lat) && Number.isFinite(body.origin.lng)) {
    userMsg.push(`User location: ${body.origin.lat}, ${body.origin.lng}`);
  }
  if (Array.isArray(body.regions) && body.regions.length) {
    userMsg.push(`Allowed regions: ${body.regions.join(", ")}`);
  }

  const out = await geminiJson(apiKey, SYSTEM_PROMPT, userMsg.join("\n"));
  if ((out as any).fatal) return json({ error: "gemini_error", ...(out as any).fatal }, (out as any).fatal.status);
  if (!(out as any).text)  return json({ error: "gemini_exhausted", detail: (out as any).err }, 429);

  const raw = (out as any).text as string;
  let intent: any = null;
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) { try { intent = JSON.parse(m[0]); } catch { intent = null; } }
  if (!intent) {
    intent = { kind: "unknown", from: null, to: null, region: null, entity: null, filters: {}, answer: raw || "Could not parse query." };
  }

  return json({ ok: true, intent, raw, model: (out as any).model });
});
