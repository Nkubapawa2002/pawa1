// =====================================================================
// POST /functions/v1/agent-chat
// Per-tenant web agent. Resolves the calling tenant, loads its
// (decrypted) Anthropic key, builds a tenant-flavoured system prompt,
// and runs Claude tool-use against the 24 n8n webhook tools.
//
// Body: {
//   tenant_slug:     string         // required
//   conversation_id: string         // optional, generated if missing
//   messages:        array          // [{role:"user"|"assistant", content:"..."}, ...]
//   user_message:    string         // shorthand for the latest turn
// }
//
// Response: {
//   ok: true,
//   conversation_id,
//   reply: string,                  // final assistant text
//   tool_calls: [{name, ms, ok}],   // summary
//   messages: [...updated history]
// }
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/cors.ts";
import { TOOLS, TOOL_BY_NAME } from "./tools.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PASSPHRASE   = Deno.env.get("TENANT_SECRET_PASSPHRASE") || "";
const N8N_BASE     = (Deno.env.get("N8N_WEBHOOK_BASE") || "").replace(/\/$/, "");
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MAX_LOOPS    = 12;
const MAX_TOKENS   = 1024;

type Msg = { role: "user" | "assistant"; content: any };
type ToolCallSummary = { name: string; ms: number; ok: boolean; error?: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")    return json({ error: "method_not_allowed" }, 405);
  if (!PASSPHRASE) return json({ error: "passphrase_not_set" }, 500);
  if (!N8N_BASE)   return json({ error: "n8n_base_not_set", detail: "N8N_WEBHOOK_BASE missing" }, 500);

  let payload: any;
  try { payload = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const { tenant_slug, user_message } = payload || {};
  let { conversation_id, messages } = payload || {};
  if (typeof tenant_slug !== "string") return json({ error: "tenant_slug_required" }, 400);

  conversation_id ||= "web-" + crypto.randomUUID();
  messages = Array.isArray(messages) ? [...messages] : [];
  if (typeof user_message === "string" && user_message.trim()) {
    messages.push({ role: "user", content: user_message });
  }
  if (messages.length === 0) return json({ error: "messages_required" }, 400);

  // ---- Resolve tenant and decrypt secrets ------------------------
  const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: tdata, error: terr } = await sb.rpc("tenant_resolve_by_slug", {
    _slug: tenant_slug, _passphrase: PASSPHRASE,
  });
  if (terr)        return json({ error: "tenant_lookup_failed", detail: terr.message }, 400);
  if (!tdata?.[0]) return json({ error: "tenant_not_found" }, 404);
  const T = tdata[0] as any;
  if (T.status !== "active") return json({ error: "tenant_not_active", status: T.status }, 423);
  if (!T.anthropic_api_key)  return json({ error: "anthropic_key_missing", hint: "Configure on /dashboard.html" }, 412);

  // ---- Build system prompt --------------------------------------
  const branding = T.branding || {};
  const agentName    = branding.agent_name || "PAWA";
  const companyName  = branding.company_name_display || T.display_name || "this company";
  const tagline      = branding.tagline || "";
  const langs        = (T.languages || ["sw","en"]).join(", ");
  const defaultLang  = T.default_language || "sw";
  const overrides    = T.system_prompt_overrides || "";

  const systemPrompt = `
You are ${agentName}, the AI agent for ${companyName}. You handle bus seat bookings AND parcel cargo, end-to-end. You can call tools to search trips, hold seats, register parcels, send SMS / WhatsApp, queue outbound calls, schedule reminders, and pull manager metrics.

Tenant slug: ${T.slug}.
Languages enabled: ${langs}. Default language: ${defaultLang}. Mirror the user's language; for ambiguous input, default to ${defaultLang}.
Tagline (use sparingly): ${tagline}

Rules:
- Always confirm passenger / sender names + phone before any insert.
- Never invent trip ids, prices, agents, buses, or shipments — call a tool.
- Booking flow: search_trips → check_seats → hold_seat → initiate_payment.
- Cargo flow: find_buses_for_route → compute_freight_quote → register_shipment → send_sms (tracking code to sender + receiver).
- For escalations or refund/reschedule beyond policy: call escalate AND trigger_outbound_call to the manager.
- Keep replies short (≤ 150 words). Use bullet lists when summarising tool output.
- For dates use YYYY-MM-DD. For times use 24h Tanzania time (then mention Swahili form on voice).

${overrides ? `Tenant-specific instructions:\n${overrides}` : ""}
`.trim();

  // ---- Tool-use loop ---------------------------------------------
  const toolDefs = TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
  const toolCalls: ToolCallSummary[] = [];
  let finalText = "";

  for (let i = 0; i < MAX_LOOPS; i++) {
    const aRes = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type":     "application/json",
        "x-api-key":        T.anthropic_api_key,
        "anthropic-version":"2023-06-01",
      },
      body: JSON.stringify({
        model:      T.anthropic_model || "claude-opus-4-7",
        max_tokens: MAX_TOKENS,
        system:     systemPrompt,
        tools:      toolDefs,
        messages,
      }),
    });
    if (!aRes.ok) {
      const txt = await aRes.text();
      return json({ error: "anthropic_failed", status: aRes.status, detail: txt.slice(0, 500) }, 502);
    }
    const data = await aRes.json();
    const blocks: any[] = data.content || [];
    // Append assistant turn (so the next request includes it).
    messages.push({ role: "assistant", content: blocks });

    const stopReason = data.stop_reason;
    const toolUses = blocks.filter(b => b.type === "tool_use");

    // Capture any text before the tool calls, in case Claude narrates.
    const sayText = blocks.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
    if (sayText) finalText = sayText;

    if (stopReason !== "tool_use" || toolUses.length === 0) {
      // Done.
      break;
    }

    // Execute tools sequentially (simpler; n8n sometimes shares tenant state).
    const toolResults: any[] = [];
    for (const tu of toolUses) {
      const def = TOOL_BY_NAME[tu.name];
      const t0 = Date.now();
      let resultText = "";
      let ok = true;
      let errStr: string | undefined;
      try {
        if (!def) throw new Error(`unknown_tool ${tu.name}`);
        const body = { tenant_slug, ...tu.input };
        const r = await fetch(N8N_BASE + def.webhook_path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const text = await r.text();
        if (!r.ok) throw new Error(`n8n_${r.status}: ${text.slice(0, 200)}`);
        let parsed: any;
        try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
        // Workflow returns { results: [{ toolCallId, result }] } — extract the result string.
        resultText = parsed?.results?.[0]?.result
                  ?? parsed?.result
                  ?? text;
      } catch (e: any) {
        ok = false;
        errStr = e?.message || String(e);
        resultText = `Error: ${errStr}`;
      }
      const ms = Date.now() - t0;
      toolCalls.push({ name: tu.name, ms, ok, error: errStr });

      // Best-effort log (don't fail the chat if this errors).
      sb.rpc("log_agent_action", {
        _conversation_id: conversation_id,
        _channel: "web",
        _tool_name: tu.name,
        _arguments: tu.input,
        _result_summary: resultText.slice(0, 500),
        _latency_ms: ms,
        _ok: ok,
        _error: errStr || null,
      }).catch(() => {});

      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: resultText,
        is_error: !ok,
      });
    }
    // Append all tool results in one user turn.
    messages.push({ role: "user", content: toolResults });
  }

  return json({
    ok: true,
    conversation_id,
    reply: finalText || "(no reply)",
    tool_calls: toolCalls,
    messages,
  });
});
