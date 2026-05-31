// =====================================================================
// POST /functions/v1/ai-chat
// Generic Claude chat proxy used by chat.html and any browser-side
// feature that needs a plain conversational reply. The ANTHROPIC_API_KEY
// lives only as an Edge Function secret; the browser never sees it.
//
// Body: {
//   messages: [{ role: "user"|"assistant", content: string }, ...]   // required
//   system?:  string                  // optional system prompt
//   model?:   string                  // default: claude-opus-4-7
//   max_tokens?: number               // default: 1024
//   temperature?: number              // default: 0.7
// }
//
// Response: { ok: true, reply: string, model, usage }
// =====================================================================

import { corsHeaders, json } from "../_shared/cors.ts";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-opus-4-7";
const DEFAULT_MAX_TOKENS = 1024;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")    return json({ error: "method_not_allowed" }, 405);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "anthropic_key_missing" }, 500);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }

  const messages = Array.isArray(body?.messages) ? body.messages : [];
  if (messages.length === 0) return json({ error: "messages_required" }, 400);

  const model       = typeof body.model === "string"  ? body.model       : DEFAULT_MODEL;
  const maxTokens   = Number.isFinite(body.max_tokens) ? body.max_tokens : DEFAULT_MAX_TOKENS;
  const temperature = Number.isFinite(body.temperature) ? body.temperature : 0.7;

  // System prompt: if provided and long enough to be worth caching, mark it
  // ephemeral so repeated turns reuse the same prefix.
  let systemField: any = undefined;
  if (typeof body.system === "string" && body.system.trim()) {
    const sys = body.system.trim();
    systemField = sys.length >= 1024
      ? [{ type: "text", text: sys, cache_control: { type: "ephemeral" } }]
      : sys;
  }

  const payload: any = {
    model,
    max_tokens: maxTokens,
    temperature,
    messages,
  };
  if (systemField) payload.system = systemField;

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

  const reply = (data?.content || [])
    .filter((b: any) => b?.type === "text")
    .map((b: any) => b.text)
    .join("\n")
    .trim();

  return json({
    ok: true,
    reply,
    model: data?.model || model,
    usage: data?.usage || null,
    stop_reason: data?.stop_reason || null,
  });
});
