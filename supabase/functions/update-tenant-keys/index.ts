// =====================================================================
// POST /functions/v1/update-tenant-keys
// Tenant owner / admin posts plaintext API keys; the function
// encrypts each one with TENANT_SECRET_PASSPHRASE and writes
// ciphertext to tenant_settings via the update_tenant_secret() SQL
// helper. Plaintext never leaves this function.
//
// Body: {
//   tenant_id: uuid,
//   keys: { <key_name>: <plaintext> | null, ... }
// }
//
// Allowed keys (must match update_tenant_secret whitelist):
//   anthropic_api_key, anthropic_model,
//   vapi_private_key, vapi_public_key, vapi_assistant_id, vapi_phone_number_id,
//   at_api_key, at_username, at_sender_id, at_whatsapp_number,
//   payment_gateway, payment_gateway_token, payment_gateway_secret
//
// Auth: Bearer JWT. The user must be owner or admin of the tenant.
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PASSPHRASE   = Deno.env.get("TENANT_SECRET_PASSPHRASE") || "";

const ALLOWED_KEYS = new Set([
  "anthropic_api_key", "anthropic_model",
  "vapi_private_key", "vapi_public_key", "vapi_assistant_id", "vapi_phone_number_id",
  "at_api_key", "at_username", "at_sender_id", "at_whatsapp_number",
  "payment_gateway", "payment_gateway_token", "payment_gateway_secret",
]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")    return json({ error: "method_not_allowed" }, 405);
  if (!PASSPHRASE) return json({ error: "passphrase_not_set", detail: "TENANT_SECRET_PASSPHRASE missing" }, 500);

  // ---- auth ------------------------------------------------------
  const authHdr = req.headers.get("Authorization") || "";
  const token = authHdr.replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "unauthenticated" }, 401);

  const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: userResp, error: uerr } = await sb.auth.getUser(token);
  if (uerr || !userResp?.user) return json({ error: "invalid_token" }, 401);
  const userId = userResp.user.id;

  // ---- body -----------------------------------------------------
  let payload: any;
  try { payload = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const { tenant_id, keys } = payload || {};
  if (typeof tenant_id !== "string") return json({ error: "tenant_id_required" }, 400);
  if (!keys || typeof keys !== "object") return json({ error: "keys_required" }, 400);

  // ---- authorization: must be owner or admin of the tenant ------
  const { data: membership, error: merr } = await sb
    .from("tenant_users")
    .select("role")
    .eq("tenant_id", tenant_id)
    .eq("user_id", userId)
    .maybeSingle();
  if (merr || !membership) return json({ error: "forbidden" }, 403);
  if (membership.role !== "owner" && membership.role !== "admin")
    return json({ error: "forbidden", detail: "owner/admin only" }, 403);

  // ---- write ---------------------------------------------------
  const updated: string[] = [];
  const skipped: { key: string; reason: string }[] = [];

  for (const [k, v] of Object.entries(keys)) {
    if (!ALLOWED_KEYS.has(k)) { skipped.push({ key: k, reason: "not_allowed" }); continue; }
    if (v === undefined)     { continue; }              // missing => leave alone
    if (v === null || v === "") {
      // Caller wants to clear this key — store NULL via the same fn
      // (passing empty string returns NULL for encrypted columns).
      const { error } = await sb.rpc("update_tenant_secret", {
        _tenant_id: tenant_id,
        _passphrase: PASSPHRASE,
        _key_name: k,
        _value: "",
      });
      if (error) skipped.push({ key: k, reason: "rpc_failed: " + error.message });
      else updated.push(k);
      continue;
    }
    if (typeof v !== "string") { skipped.push({ key: k, reason: "not_a_string" }); continue; }

    const { error } = await sb.rpc("update_tenant_secret", {
      _tenant_id: tenant_id,
      _passphrase: PASSPHRASE,
      _key_name: k,
      _value: v,
    });
    if (error) skipped.push({ key: k, reason: "rpc_failed: " + error.message });
    else updated.push(k);
  }

  // ---- audit ---------------------------------------------------
  await sb.from("manager_actions").insert({
    action_type: "tenant_keys_updated",
    summary: `Keys updated: ${updated.join(", ")}`,
    payload: { tenant_id, updated, skipped, by: userId },
    status: "resolved",
    resolved_by: userResp.user.email,
    resolved_at: new Date().toISOString(),
  }).catch(() => {});

  return json({ ok: true, updated, skipped });
});
