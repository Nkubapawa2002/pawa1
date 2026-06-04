// =====================================================================
// POST /functions/v1/gemini-chat
// Server-side proxy for the Gemini text chat that powers the AI Assistant
// on chat.html. The GEMINI_API_KEY lives only as an Edge Function secret;
// the browser never sees it.
//
// The free tier is ~20 requests/day PER MODEL, so this tries a chain of
// models and advances to the next when one hits its daily quota (429) —
// keeping the assistant on real AI instead of a canned fallback.
//
// Body: {
//   messages: [{ role: "user"|"assistant", content: string }, ...]   // required
//   system?:  string
//   models?:  string[]                // override the default chain
//   max_tokens?: number               // default 1024
//   temperature?: number              // default 0.6
// }
// Response: { ok: true, reply: string, model: string }
// =====================================================================

import { corsHeaders, json } from "../_shared/cors.ts";

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-flash-latest",
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite",
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")    return json({ error: "method_not_allowed" }, 405);

  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) return json({ error: "gemini_key_missing" }, 500);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }

  const messages = Array.isArray(body?.messages) ? body.messages : [];
  if (messages.length === 0) return json({ error: "messages_required" }, 400);

  const models = Array.isArray(body?.models) && body.models.length ? body.models : DEFAULT_MODELS;
  const maxTokens   = Number.isFinite(body.max_tokens)  ? body.max_tokens  : 1024;
  const temperature = Number.isFinite(body.temperature) ? body.temperature : 0.6;

  const contents = messages
    .filter((m: any) => m && m.content)
    .map((m: any) => ({
      role:  m.role === "assistant" ? "model" : "user",
      parts: [{ text: String(m.content) }],
    }));

  const payload: any = {
    contents,
    generationConfig: {
      maxOutputTokens: maxTokens,
      temperature,
      thinkingConfig: { thinkingBudget: 0 },   // no hidden "thinking" → fast replies
    },
  };
  if (typeof body.system === "string" && body.system.trim()) {
    payload.systemInstruction = { parts: [{ text: body.system.trim() }] };
  }

  let lastErr = "gemini_unavailable";
  for (const model of models) {
    let res: Response;
    try {
      res = await fetch(`${BASE}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(payload),
      });
    } catch (e) {
      lastErr = String(e);   // network error — try next model
      continue;
    }

    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      const reply = (data?.candidates?.[0]?.content?.parts || [])
        .map((p: any) => p.text || "").join("").trim();
      if (reply) return json({ ok: true, reply, model });
      lastErr = "empty_reply";
      continue;
    }

    lastErr = data?.error?.message || `gemini_${res.status}`;
    // Out of daily quota / busy / no such model → try the next model.
    if (res.status === 429 || res.status === 503 || res.status === 404) continue;
    // Anything else (bad request / bad key) is fatal.
    return json({ error: "gemini_error", status: res.status, detail: data }, res.status);
  }

  return json({ error: "gemini_exhausted", detail: lastErr }, 429);
});
