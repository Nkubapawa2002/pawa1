// =====================================================================
// POST /functions/v1/get-tenant-config
// Server-only: returns a tenant's full runtime config (decrypted keys
// + branding + agent prompt overrides) for n8n / agent-chat to use.
//
// Auth: must present the SERVICE-ROLE bearer token in Authorization.
// Browsers MUST NOT call this — it returns plaintext secrets.
//
// Body: { tenant_slug: string }  OR  { tenant_id: uuid }
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PASSPHRASE   = Deno.env.get("TENANT_SECRET_PASSPHRASE") || "";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")    return json({ error: "method_not_allowed" }, 405);
  if (!PASSPHRASE) return json({ error: "passphrase_not_set" }, 500);

  // ---- service-role guard ---------------------------------------
  // We require the caller to present the service-role JWT. The
  // service-role key value is in env, so we string-compare.
  const authHdr = req.headers.get("Authorization") || "";
  const token = authHdr.replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "unauthenticated" }, 401);
  if (token !== SERVICE_KEY) return json({ error: "service_role_required" }, 403);

  // ---- body --------------------------------------------------
  let payload: any;
  try { payload = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const { tenant_slug, tenant_id } = payload || {};
  if (!tenant_slug && !tenant_id) return json({ error: "tenant_slug_or_id_required" }, 400);

  const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const rpcArgs = tenant_slug
    ? { _slug: tenant_slug, _passphrase: PASSPHRASE }
    : { _tenant_id: tenant_id, _passphrase: PASSPHRASE };
  const rpcName = tenant_slug ? "tenant_resolve_by_slug" : "tenant_get_secrets";

  const { data, error } = await sb.rpc(rpcName, rpcArgs);
  if (error)        return json({ error: "rpc_failed", detail: error.message }, 400);
  if (!data?.[0])   return json({ error: "tenant_not_found" }, 404);

  const row = data[0];
  if (row.status !== "active") {
    return json({ error: "tenant_not_active", status: row.status }, 423);
  }

  return json({
    ok: true,
    tenant_id:                 row.tenant_id,
    slug:                      row.slug,
    display_name:              row.display_name,
    status:                    row.status,
    anthropic_api_key:         row.anthropic_api_key,
    anthropic_model:           row.anthropic_model,
    vapi_private_key:          row.vapi_private_key,
    vapi_public_key:           row.vapi_public_key,
    vapi_assistant_id:         row.vapi_assistant_id,
    vapi_phone_number_id:      row.vapi_phone_number_id,
    at_api_key:                row.at_api_key,
    at_username:               row.at_username,
    at_sender_id:              row.at_sender_id,
    at_whatsapp_number:        row.at_whatsapp_number,
    payment_gateway:           row.payment_gateway,
    payment_gateway_token:     row.payment_gateway_token,
    payment_gateway_secret:    row.payment_gateway_secret,
    branding:                  row.branding,
    languages:                 row.languages,
    default_language:          row.default_language,
    system_prompt_overrides:   row.system_prompt_overrides,
  });
});
