-- ============================================================================
-- RLS + index tuning. The NON-DESTRUCTIVE half of the 2026-08-18 audit.
--
-- Nothing here removes a table, a function or data. The companion file,
-- 2026-08-18_drop_bus_era_and_tune_rls.sql, holds the bus-era removals and is
-- applied separately.
--
-- Policies are changed with ALTER POLICY rather than dropped and recreated, so
-- no policy ever ceases to exist — not even briefly, and not even inside the
-- transaction. Roles, command and permissive/restrictive flags are untouched by
-- construction; only the expression changes.
--
-- Idempotent: re-running rewrites the same expressions to the same thing.
--
-- Apply:  Supabase Dashboard -> SQL Editor -> paste -> Run
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. handle_payment_completion — drop the dead branches, keep the live one
--
-- This is the trg_payment_complete trigger on the live payments table. Its
-- booking / reschedule / shipment branches all reference tables deleted in the
-- pivot. They never fire today (payments.reference_type is 'booking' on 6
-- legacy rows and 'agent_subscription' on the live ones) and PL/pgSQL does not
-- resolve a table name until the statement runs — which is why payments have
-- gone on working.
--
-- The function is NOT dropped: the paid_at stamp below applies to every payment
-- type, agent subscriptions included.
-- ---------------------------------------------------------------------------
create or replace function public.handle_payment_completion()
returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  -- Stamp paid_at on the transition into 'completed', for every payment type.
  if new.status = 'completed' and (old.status is null or old.status <> 'completed') then
    if new.paid_at is null then
      new.paid_at := now();
    end if;
  end if;
  return new;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 2. Evaluate the admin check ONCE per statement, not once per row
--
-- Postgres re-evaluates a bare is_admin() for every candidate row, and
-- is_admin() itself runs `select exists (select 1 from admins where
-- lower(email) = ...)` — a sequential scan. That is why a 1-row admins table
-- had accumulated 5,182 sequential scans.
--
-- Wrapping the call in a scalar subquery makes it an InitPlan: evaluated once
-- and reused for the whole statement. Invisible at today's row counts, and
-- decisive at 10,000 listings — which is exactly when it would be hardest to
-- track down.
--
-- Generated from pg_policies rather than hand-written, so every expression is
-- the one actually in force, not a guess at it.
-- ---------------------------------------------------------------------------
alter policy "admins read self" on public.admins using ((select public.is_admin()));
alter policy "admins write" on public.admins using ((select public.is_admin())) with check ((select public.is_admin()));
alter policy "agent_actions_log admin all" on public.agent_actions_log using ((select public.is_admin())) with check ((select public.is_admin()));
alter policy "applications read admin" on public.agent_applications using ((select public.is_admin()));
alter policy "applications read tenant" on public.agent_applications using (((select public.is_admin()) OR (tenant_id IN ( SELECT current_user_tenant_ids() AS current_user_tenant_ids))));
alter policy "applications update admin" on public.agent_applications using ((select public.is_admin())) with check ((select public.is_admin()));
alter policy "applications update tenant" on public.agent_applications using (((select public.is_admin()) OR (tenant_id IN ( SELECT tu.tenant_id FROM tenant_users tu WHERE (((tu.user_id)::text = ( SELECT app_uid() AS app_uid)) AND (tu.role = ANY (ARRAY['owner'::tenant_role, 'admin'::tenant_role]))))))) with check (((select public.is_admin()) OR (tenant_id IN ( SELECT tu.tenant_id FROM tenant_users tu WHERE (((tu.user_id)::text = ( SELECT app_uid() AS app_uid)) AND (tu.role = ANY (ARRAY['owner'::tenant_role, 'admin'::tenant_role])))))));
alter policy "agent_billing admin read" on public.agent_billing using ((select public.is_admin()));
alter policy "agent_billing admin write" on public.agent_billing using ((select public.is_admin())) with check ((select public.is_admin()));
alter policy "agent_messages admin all" on public.agent_messages using ((select public.is_admin())) with check ((select public.is_admin()));
alter policy "agent_messages self read" on public.agent_messages using (((to_user_id = ( SELECT app_uid() AS app_uid)) OR (select public.is_admin())));
alter policy "agent_payments admin read" on public.agent_payments using ((select public.is_admin()));
alter policy "agent_payments admin write" on public.agent_payments using ((select public.is_admin())) with check ((select public.is_admin()));
alter policy "agent_profiles admin write" on public.agent_profiles using ((select public.is_admin())) with check ((select public.is_admin()));
alter policy "agent_profiles self read" on public.agent_profiles using (((user_id = ( SELECT app_uid() AS app_uid)) OR (select public.is_admin())));
alter policy "reviews admin delete" on public.agent_reviews using ((select public.is_admin()));
alter policy "agents admin write" on public.agents using ((select public.is_admin())) with check ((select public.is_admin()));
alter policy "agents readable" on public.agents using (((NOT phone_suspended(phone)) OR (user_id = ( SELECT app_uid() AS app_uid)) OR (select public.is_admin())));
alter policy "agents tenant write" on public.agents using (((select public.is_admin()) OR (tenant_id IN ( SELECT tu.tenant_id FROM tenant_users tu WHERE (((tu.user_id)::text = ( SELECT app_uid() AS app_uid)) AND (tu.role = ANY (ARRAY['owner'::tenant_role, 'admin'::tenant_role]))))))) with check (((select public.is_admin()) OR (tenant_id IN ( SELECT tu.tenant_id FROM tenant_users tu WHERE (((tu.user_id)::text = ( SELECT app_uid() AS app_uid)) AND (tu.role = ANY (ARRAY['owner'::tenant_role, 'admin'::tenant_role])))))));
alter policy "day_job_claims admin read" on public.day_job_claims using ((select public.is_admin()));
alter policy "day_jobs admin delete" on public.day_jobs using ((select public.is_admin()));
alter policy "day_jobs admin update" on public.day_jobs using ((select public.is_admin())) with check ((select public.is_admin()));
alter policy "ht admin update" on public.house_tenancies using ((select public.is_admin())) with check ((select public.is_admin()));
alter policy "ht owner+admin read" on public.house_tenancies using (((owner_user_id = ( SELECT app_uid() AS app_uid)) OR (select public.is_admin())));
alter policy "houses readable" on public.houses using (((NOT uid_suspended(owner_user_id)) OR (owner_user_id = ( SELECT app_uid() AS app_uid)) OR (select public.is_admin())));
alter policy "manager_actions admin all" on public.manager_actions using ((select public.is_admin())) with check ((select public.is_admin()));
alter policy finance_select_payments on public.payments using ((select public.is_finance_user()));
alter policy "region_video_defaults admin write" on public.region_video_defaults using ((select public.is_admin())) with check ((select public.is_admin()));
alter policy "region_videos admin all" on public.region_videos using ((select public.is_admin())) with check ((select public.is_admin()));
alter policy "services admin write" on public.services using ((select public.is_admin())) with check ((select public.is_admin()));
alter policy "services readable" on public.services using (((NOT uid_suspended(owner_user_id)) OR (owner_user_id = ( SELECT app_uid() AS app_uid)) OR (select public.is_admin())));
alter policy "tenant_settings owner write" on public.tenant_settings using (((select public.is_super_admin()) OR (EXISTS ( SELECT 1 FROM tenant_users tu WHERE ((tu.tenant_id = tenant_settings.tenant_id) AND ((tu.user_id)::text = ( SELECT app_uid() AS app_uid)) AND (tu.role = ANY (ARRAY['owner'::tenant_role, 'admin'::tenant_role]))))))) with check (((select public.is_super_admin()) OR (EXISTS ( SELECT 1 FROM tenant_users tu WHERE ((tu.tenant_id = tenant_settings.tenant_id) AND ((tu.user_id)::text = ( SELECT app_uid() AS app_uid)) AND (tu.role = ANY (ARRAY['owner'::tenant_role, 'admin'::tenant_role])))))));
alter policy "tenant_settings read" on public.tenant_settings using (((select public.is_super_admin()) OR (tenant_id IN ( SELECT current_user_tenant_ids() AS current_user_tenant_ids))));
alter policy "tenant_users owner write" on public.tenant_users using (((select public.is_super_admin()) OR (EXISTS ( SELECT 1 FROM tenants t WHERE ((t.id = tenant_users.tenant_id) AND ((t.owner_user_id)::text = ( SELECT app_uid() AS app_uid))))))) with check (((select public.is_super_admin()) OR (EXISTS ( SELECT 1 FROM tenants t WHERE ((t.id = tenant_users.tenant_id) AND ((t.owner_user_id)::text = ( SELECT app_uid() AS app_uid)))))));
alter policy "tenant_users self read" on public.tenant_users using (((select public.is_super_admin()) OR ((user_id)::text = ( SELECT app_uid() AS app_uid)) OR (tenant_id IN ( SELECT current_user_tenant_ids() AS current_user_tenant_ids))));
alter policy "tenant admin delete" on public.tenants using ((select public.is_admin()));
alter policy "tenant members read" on public.tenants using (((select public.is_super_admin()) OR (id IN ( SELECT current_user_tenant_ids() AS current_user_tenant_ids))));
alter policy "tenant owner update" on public.tenants using ((((owner_user_id)::text = ( SELECT app_uid() AS app_uid)) OR (select public.is_super_admin()))) with check ((((owner_user_id)::text = ( SELECT app_uid() AS app_uid)) OR (select public.is_super_admin())));
alter policy "trucks admin write" on public.trucks using ((select public.is_admin())) with check ((select public.is_admin()));
alter policy "trucks readable" on public.trucks using (((NOT uid_suspended(owner_user_id)) OR (owner_user_id = ( SELECT app_uid() AS app_uid)) OR (select public.is_admin())));

-- ---------------------------------------------------------------------------
-- 3. The one missing index
--
-- is_admin() compares lower(email); without a matching functional index every
-- call sequentially scans admins. One line, and it is the index that the
-- hoisting above still depends on for the single remaining evaluation.
--
-- Note on what is NOT here: the ~60 indexes on houses, trucks and services that
-- report zero scans are left alone deliberately. They read as unused because
-- those tables hold ONE row each, and Postgres always prefers a sequential scan
-- at that size. idx_scan = 0 means "no data yet", not "dead index".
-- ---------------------------------------------------------------------------
create index if not exists admins_lower_email_idx on public.admins (lower(email));

-- ---------------------------------------------------------------------------
-- 4. Parallel safety
--
-- All four are STABLE and read-only but default to PARALLEL UNSAFE, which rules
-- out a parallel plan for any query whose RLS policy calls them — including the
-- public listing reads on houses / trucks / services. Marking them safe costs
-- nothing and stops that whole class of plan being discarded up front.
-- ---------------------------------------------------------------------------
alter function public.is_admin()                parallel safe;
alter function public.app_uid()                 parallel safe;
alter function public.uid_suspended(text)       parallel safe;
alter function public.agent_key_suspended(text) parallel safe;

commit;
