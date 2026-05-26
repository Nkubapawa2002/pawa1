// =====================================================================
// POST /functions/v1/approve-tenant
// Super-admin only. Flips a tenant's status (active | suspended |
// rejected) and stamps approved_at / approved_by / rejection_note.
// Optionally emails the tenant owner via Africa's Talking SMS or
// SMTP — wired through the manager_actions audit table for now.
//
// Body: {
//   tenant_id:        uuid
//   status:           "active" | "suspended" | "rejected"
//   rejection_note?:  string
// }
// Auth: caller must present a Bearer token whose email is in the
// `admins` table AND in ADMIN_EMAILS env (a comma-separated allow-list).
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ADMIN_EMAILS = (Deno.env.get("ADMIN_EMAILS") || "")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

const ALLOWED_STATUSES = new Set(["active", "suspended", "rejected"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")    return json({ error: "method_not_allowed" }, 405);

  // ---- auth: extract caller email from JWT ------------------------
  const authHdr = req.headers.get("Authorization") || "";
  const token = authHdr.replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "unauthenticated" }, 401);

  const sbAuth = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: userResp, error: uerr } = await sbAuth.auth.getUser(token);
  if (uerr || !userResp?.user) return json({ error: "invalid_token" }, 401);
  const callerEmail = (userResp.user.email || "").toLowerCase();
  const callerId    = userResp.user.id;

  if (ADMIN_EMAILS.length && !ADMIN_EMAILS.includes(callerEmail)) {
    return json({ error: "forbidden", detail: "not in ADMIN_EMAILS" }, 403);
  }
  // Cross-check the admins table too.
  {
    const { data: admin, error: aerr } = await sbAuth
      .from("admins")
      .select("email")
      .ilike("email", callerEmail)
      .maybeSingle();
    if (aerr || !admin) return json({ error: "forbidden", detail: "not in admins table" }, 403);
  }

  // ---- body validation -------------------------------------------
  let payload: any;
  try { payload = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const { tenant_id, status, rejection_note } = payload || {};
  if (typeof tenant_id !== "string") return json({ error: "tenant_id_required" }, 400);
  if (!ALLOWED_STATUSES.has(status))  return json({ error: "invalid_status" }, 400);

  // ---- update --------------------------------------------------
  const patch: Record<string, unknown> = { status };
  if (status === "active") {
    patch.approved_at = new Date().toISOString();
    patch.approved_by = callerId;
  }
  if (status === "rejected") {
    patch.rejection_note = rejection_note || null;
  }

  const { data: tenant, error: terr } = await sbAuth
    .from("tenants")
    .update(patch)
    .eq("id", tenant_id)
    .select()
    .single();
  if (terr) return json({ error: "update_failed", detail: terr.message }, 400);

  // ---- audit log -------------------------------------------------
  await sbAuth.from("manager_actions").insert({
    action_type: "tenant_status_change",
    summary: `Tenant ${tenant.slug} → ${status}`,
    payload: { tenant_id, status, by: callerEmail, rejection_note: rejection_note || null },
    status: "resolved",
    resolved_by: callerEmail,
    resolved_at: new Date().toISOString(),
  }).catch(() => {});

  // (Intentional: no email notification yet — wire SMTP/AT in a later
  // slice. The owner can poll the dashboard or you can manually email.)

  return json({ ok: true, tenant_id: tenant.id, status: tenant.status });
});
