// =====================================================================
// POST /functions/v1/payment-callback?provider=<name>
// Receives webhook callbacks from any configured provider.
// Verifies the signature, updates `payments`, appends to
// `payment_callbacks`, and lets the DB trigger flip the booking/shipment.
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/cors.ts";
import { providerByName } from "../_shared/registry.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")    return json({ error: "method_not_allowed" }, 405);

  const url = new URL(req.url);
  const providerName = (url.searchParams.get("provider") || "").toLowerCase();
  const provider = providerByName(providerName);
  if (!provider) return json({ error: "unknown_provider", providerName }, 400);

  // Capture headers and body for audit log
  const headers: Record<string,string> = {};
  req.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });

  let body: unknown;
  try { body = await req.json(); }
  catch { body = await req.text().catch(() => ""); }

  const result = provider.verifyCallback({ headers, body });

  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false }});

  // Audit row first
  let payment_id: string | null = null;
  if (result.provider_ref) {
    const { data } = await sb.from("payments")
      .select("id")
      .eq("provider_ref", result.provider_ref)
      .maybeSingle();
    payment_id = data?.id ?? null;
  }

  await sb.from("payment_callbacks").insert({
    payment_id,
    provider:     providerName,
    event_type:   result.status,
    signature_ok: result.valid,
    http_status:  200,
    ip_address:   headers["x-forwarded-for"] || headers["cf-connecting-ip"] || null,
    raw_headers:  headers,
    raw_body:     typeof body === "string" ? { text: body } : body,
  });

  if (!result.valid) return json({ ok: false, reason: "invalid_signature" }, 400);

  if (payment_id) {
    const update: Record<string, unknown> = {
      raw_callback: typeof body === "string" ? { text: body } : body,
    };
    if (result.status === "completed") {
      update.status   = "completed";
      update.paid_at  = result.paid_at || new Date().toISOString();
      update.external_ref = result.external_ref;
    } else if (result.status === "failed") {
      update.status        = "failed";
      update.error_message = "Provider reported failure";
    } else if (result.status === "cancelled") {
      update.status = "cancelled";
    } else if (result.status === "processing") {
      update.status = "processing";
    }
    await sb.from("payments").update(update).eq("id", payment_id);
  }

  return json({ ok: true, status: result.status, payment_id });
});
