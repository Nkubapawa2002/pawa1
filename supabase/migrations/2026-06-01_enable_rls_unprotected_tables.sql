-- =====================================================================
-- Security fix — enable RLS on 5 unprotected public tables
-- =====================================================================
-- Audit (scripts/db_audit.mjs) found these tables with RLS DISABLED while
-- the public `anon` role holds full grants (SELECT/INSERT/UPDATE/DELETE/
-- TRUNCATE). Because the anon key ships in js/config.js, anyone on the
-- internet could read or wipe them. Notably scheduled_reminders held ~650
-- rows of customer phone numbers + message bodies.
--
-- All legitimate writers use the SERVICE ROLE (n8n SUPABASE_SERVICE_KEY,
-- Edge Functions SUPABASE_SERVICE_ROLE_KEY) or SECURITY DEFINER triggers
-- (set_default_reminder). Both BYPASS RLS, so enabling RLS with admin-only
-- policies locks out the public without breaking the automation.
--
-- Idempotent — safe to run more than once.
-- =====================================================================

-- ---- agent_actions_log -------------------------------------------------
alter table public.agent_actions_log enable row level security;
drop policy if exists "agent_actions_log admin all" on public.agent_actions_log;
create policy "agent_actions_log admin all" on public.agent_actions_log
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ---- manager_actions ---------------------------------------------------
alter table public.manager_actions enable row level security;
drop policy if exists "manager_actions admin all" on public.manager_actions;
create policy "manager_actions admin all" on public.manager_actions
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ---- message_log -------------------------------------------------------
alter table public.message_log enable row level security;
drop policy if exists "message_log admin all" on public.message_log;
create policy "message_log admin all" on public.message_log
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ---- parcel_quotes -----------------------------------------------------
alter table public.parcel_quotes enable row level security;
drop policy if exists "parcel_quotes admin all" on public.parcel_quotes;
create policy "parcel_quotes admin all" on public.parcel_quotes
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ---- scheduled_reminders ----------------------------------------------
alter table public.scheduled_reminders enable row level security;
drop policy if exists "scheduled_reminders admin all" on public.scheduled_reminders;
create policy "scheduled_reminders admin all" on public.scheduled_reminders
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
