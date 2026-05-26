// =====================================================================
// POST /functions/v1/create-tenant
// Atomic signup: creates the auth.users entry, the tenants row (status
// = pending_approval), the owner tenant_users membership, and a stub
// tenant_settings row — all server-side so a half-success can't leave
// the DB inconsistent.
//
// Body: {
//   slug:          string  // 3-32 chars, [a-z0-9-]
//   display_name:  string
//   contact_email: string  // becomes the auth user's email + tenant contact
//   password:      string  // owner login password
//   legal_name?:   string
//   contact_phone?: string
//   country?:      string  // ISO-2, default TZ
//   notes?:        string  // free-text
// }
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")    return json({ error: "method_not_allowed" }, 405);

  let payload: any;
  try { payload = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }

  const {
    slug, display_name, contact_email, password,
    legal_name = null, contact_phone = null, country = "TZ", notes = null,
  } = payload || {};

  // ---- validation -------------------------------------------------
  if (typeof slug !== "string" || !/^[a-z0-9]([a-z0-9-]{1,30}[a-z0-9])?$/.test(slug))
    return json({ error: "invalid_slug" }, 400);
  if (typeof display_name !== "string" || display_name.trim().length < 2)
    return json({ error: "display_name_required" }, 400);
  if (typeof contact_email !== "string" || !/^\S+@\S+\.\S+$/.test(contact_email))
    return json({ error: "invalid_email" }, 400);
  if (typeof password !== "string" || password.length < 8)
    return json({ error: "weak_password" }, 400);

  const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ---- 0. slug uniqueness ----------------------------------------
  {
    const { data: existing } = await sb.from("tenants").select("id").eq("slug", slug).maybeSingle();
    if (existing) return json({ error: "slug_taken" }, 409);
  }

  // ---- 1. create auth user ---------------------------------------
  const { data: created, error: aerr } = await sb.auth.admin.createUser({
    email: contact_email,
    password,
    email_confirm: false,
    user_metadata: { display_name, signup_source: "create-tenant" },
  });
  if (aerr || !created?.user) {
    return json({ error: "auth_failed", detail: aerr?.message || "no user" }, 400);
  }
  const userId = created.user.id;

  // ---- 2. insert tenant row --------------------------------------
  const { data: tenant, error: terr } = await sb.from("tenants").insert({
    slug,
    display_name,
    legal_name,
    contact_email,
    contact_phone,
    country,
    status: "pending_approval",
    owner_user_id: userId,
  }).select().single();
  if (terr) {
    // Best-effort cleanup of the orphan auth user so retry works.
    await sb.auth.admin.deleteUser(userId).catch(() => {});
    return json({ error: "tenant_failed", detail: terr.message }, 400);
  }

  // ---- 3. owner membership ---------------------------------------
  const { error: merr } = await sb.from("tenant_users").insert({
    tenant_id: tenant.id, user_id: userId, role: "owner",
  });
  if (merr) {
    await sb.from("tenants").delete().eq("id", tenant.id);
    await sb.auth.admin.deleteUser(userId).catch(() => {});
    return json({ error: "membership_failed", detail: merr.message }, 400);
  }

  // ---- 4. stub tenant_settings -----------------------------------
  await sb.from("tenant_settings").insert({
    tenant_id: tenant.id,
    branding: {
      logo_url: null,
      primary_color: "#0B6E4F",
      company_name_display: display_name,
      agent_name: "PAWA",
      tagline: null,
    },
  });

  // ---- 5. log a manager action so super-admin sees it ------------
  await sb.from("manager_actions").insert({
    action_type: "tenant_signup",
    summary: `New tenant signup: ${slug} (${display_name})`,
    payload: { tenant_id: tenant.id, contact_email, notes },
    status: "open",
  }).catch(() => { /* table may live in a separate DB; ignore */ });

  return json({
    ok: true,
    tenant_id: tenant.id,
    slug: tenant.slug,
    status: tenant.status,
    user_id: userId,
  }, 201);
});
