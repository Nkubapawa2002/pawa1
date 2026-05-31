// =====================================================================
// POST /functions/v1/ai-think
// Claude-backed decision / algorithm helper. Use for routing choices,
// pricing reasoning, recommendation ranking — anything where you want
// the model to think and return a structured JSON answer.
//
// Body: {
//   task:    string                  // required, what to decide
//   context?: any                    // optional structured context (JSON)
//   schema?: object                  // optional JSON shape to return
//   model?:  string                  // default: claude-opus-4-7
//   thinking?: boolean               // enable extended thinking (default false)
//   max_tokens?: number              // default: 2048
// }
//
// Response: { ok: true, result, raw, model, usage }
//   `result` is the parsed JSON if the model returned valid JSON,
//   otherwise null; `raw` is always the text reply.
// =====================================================================

import { corsHeaders, json } from "../_shared/cors.ts";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-opus-4-7";
const DEFAULT_MAX_TOKENS = 2048;

const BASE_SYSTEM = `You are the algorithmic decision engine for Pawa, a Tanzania bus cargo and passenger ticketing platform. You receive a task plus structured context and must return a single decision.

Rules:
- Respond with a single JSON object and nothing else. No prose before or after.
- If a schema is provided, conform to it exactly. Use null for unknown fields, never invent values.
- Keep reasoning in a top-level "reasoning" string (one or two sentences) so callers can audit.
- Prefer Tanzanian regional names and Swahili/English bilingually where natural.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")    return json({ error: "method_not_allowed" }, 405);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "anthropic_key_missing" }, 500);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }

  const task = typeof body?.task === "string" ? body.task.trim() : "";
  if (!task) return json({ error: "task_required" }, 400);

  const model     = typeof body.model === "string" ? body.model : DEFAULT_MODEL;
  const maxTokens = Number.isFinite(body.max_tokens) ? body.max_tokens : DEFAULT_MAX_TOKENS;
  const wantThink = body.thinking === true;

  const userParts: string[] = [`Task: ${task}`];
  if (body.context !== undefined) {
    userParts.push(`\nContext:\n${JSON.stringify(body.context, null, 2)}`);
  }
  if (body.schema && typeof body.schema === "object") {
    userParts.push(`\nReturn a JSON object matching this schema:\n${JSON.stringify(body.schema, null, 2)}`);
  } else {
    userParts.push(`\nReturn a JSON object of the form: { "decision": <answer>, "reasoning": "<short justification>" }`);
  }

  const payload: any = {
    model,
    max_tokens: maxTokens,
    // BASE_SYSTEM is a stable prefix — cache it so repeated calls are cheap.
    system: [{ type: "text", text: BASE_SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: userParts.join("\n") }],
  };

  if (wantThink) {
    payload.thinking = { type: "enabled", budget_tokens: Math.min(maxTokens, 4000) };
    // extended thinking requires temperature = 1
    payload.temperature = 1;
  } else {
    payload.temperature = 0.2;
  }

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

  let result: any = null;
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try { result = JSON.parse(jsonMatch[0]); } catch { result = null; }
  }

  return json({
    ok: true,
    result,
    raw,
    model: data?.model || model,
    usage: data?.usage || null,
    thinking_used: wantThink,
  });
});
