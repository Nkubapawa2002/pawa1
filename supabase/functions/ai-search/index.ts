// =====================================================================
// POST /functions/v1/ai-search
//
// The AI brain for ALL search on Pawa — houses (rent/sale), rides, and
// generic "find X near me". Turns a free-text question in English OR
// Swahili into ONE structured intent the frontend engines understand
// (js/houses.js parseSmartQuery shape, js/ride.js, near-me anchor).
//
// Powered by Gemini (reuses the GEMINI_API_KEY secret that already powers
// gemini-chat). The key lives only as an Edge Function secret. Until this
// is deployed the frontend silently uses its built-in regex parser, so the
// site keeps working with zero AI — this endpoint is purely additive.
//
// Body: { query, origin?, areas?[], vehicleTypes?[], lang?, model? }
// Response: { ok:true, intent:{…}, raw, model }
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

// Keep this in lockstep with js/ai-search.js.
const SYSTEM_PROMPT = `You are the search-intent parser for Pawa, a Tanzania (TZ) housing + ride-hailing app used in English and Swahili. Convert the user's free-text request into ONE JSON object. Output the JSON only — no prose, no code fences.

Shape (always return every key; use null / [] when not stated):
{
  "domain": "house" | "ride" | "unknown",
  "answer": string,
  "nearMe": boolean,
  "place": { "name": string } | null,
  "house": {
    "listing": "rent" | "sale" | null,
    "type": "apartment" | "house" | "plot" | "office" | null,
    "bedrooms": number | null,
    "bathrooms": number | null,
    "area": string | null,
    "priceMax": number | null,
    "priceMin": number | null,
    "amenities": string[],
    "keywords": string[]
  },
  "ride": {
    "vehicleType": string | null,
    "pickup":  { "name": string } | null,
    "dropoff": { "name": string } | null,
    "when": string | null
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

async function geminiJson(apiKey: string, system: string, userText: string) {
  const payload = {
    contents: [{ role: "user", parts: [{ text: userText }] }],
    systemInstruction: { parts: [{ text: system }] },
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 700,
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

  const out = await geminiJson(apiKey, SYSTEM_PROMPT, userMsg.join("\n"));
  if ((out as any).fatal) return json({ error: "gemini_error", ...(out as any).fatal }, (out as any).fatal.status);
  if (!(out as any).text)  return json({ error: "gemini_exhausted", detail: (out as any).err }, 429);

  const raw = (out as any).text as string;
  let intent: any = null;
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) { try { intent = JSON.parse(m[0]); } catch { intent = null; } }
  if (!intent) {
    intent = {
      domain: "unknown", answer: raw || "Could not understand the request.",
      nearMe: false, place: null,
      house: { listing: null, type: null, bedrooms: null, bathrooms: null, area: null,
               priceMax: null, priceMin: null, amenities: [], keywords: [] },
      ride: { vehicleType: null, pickup: null, dropoff: null, when: null },
    };
  }

  return json({ ok: true, intent, raw, model: (out as any).model });
});
