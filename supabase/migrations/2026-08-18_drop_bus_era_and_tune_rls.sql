-- ============================================================================
-- Bus-era cleanup + RLS/index tuning.
--
-- Context: the product pivoted from bus ticketing to the housing / trucks /
-- services / day-jobs marketplace (commit 44e66c5 deleted the pages). The bus
-- TABLES were already gone from this database; what survived was the code that
-- referenced them — 23 functions that can only ever raise "relation does not
-- exist" — plus the finance-portal tables behind the deleted accounting.html.
--
-- Everything dropped here was verified unreferenced by: the frontend (js/,
-- *.html), the edge functions, every other SQL function body, all views, and
-- all foreign keys. Row data for the dropped tables is preserved in
-- docs/db-cleanup/dropped-tables-data.json (18 rows total).
--
-- Idempotent. Safe to re-run.
--
-- Apply:  Supabase Dashboard -> SQL Editor -> paste -> Run
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Orphaned finance tables (the accounting.html portal, deleted in the pivot)
--
-- No frontend reference, no edge-function reference, no SQL function reference,
-- no view, no inbound foreign key. tax_rates described itself as applying to
-- "bus tickets and cargo".
-- ---------------------------------------------------------------------------
drop table if exists public.ledger_adjustments cascade;   -- 0 rows
drop table if exists public.org_adjustments    cascade;   -- 0 rows
drop table if exists public.org_expenses       cascade;   -- 0 rows
drop table if exists public.pending_changes    cascade;   -- 5 rows (backed up)
drop table if exists public.tax_rates          cascade;   -- 12 rows (backed up)
drop table if exists public.tenant_invites     cascade;   -- 1 row  (backed up)

-- ---------------------------------------------------------------------------
-- 2. Functions referencing tables that no longer exist
--
-- Each of these was confirmed to reference at least one dropped bus-era table,
-- so it cannot execute successfully. Three of them were still scheduled in
-- pg_cron and had been failing every minute since the pivot (~4,300 errors a
-- day); those jobs were unscheduled on 2026-08-18.
--
-- Signatures are spelled out because several names are overloaded.
-- ---------------------------------------------------------------------------
drop function if exists public.add_bus_route(p_bus_id text, p_from text, p_to text, p_departure text, p_return_departure text, p_duration_hours numeric) cascade;
drop function if exists public.approve_bus_layout(p_request_id uuid) cascade;
drop function if exists public.approve_trip_cancellation(p_request_id bigint, p_note text) cascade;
drop function if exists public.authorize_payment(p_ticket_code text, p_method text, p_bank_ref text, p_customer_phone text) cascade;
drop function if exists public.cancel_custom_reminder(p_booking_id bigint) cascade;
drop function if exists public.cash_retargets_pending(p_limit integer) cascade;
drop function if exists public.cash_retargets_record(p_ticket text, p_name text, p_phone text, p_recorded_by text) cascade;
drop function if exists public.claim_reschedule_ticket(p_original_ticket text, p_new_seat integer, p_new_date date, p_passenger_name text, p_passenger_phone text) cascade;
drop function if exists public.claim_ticket(p_bus_id text, p_seat_number integer, p_travel_date date, p_departure_time text, p_origin text, p_destination text, p_passenger_name text, p_passenger_phone text, p_fare_tzs numeric, p_passenger_id_no text, p_trip_purpose text, p_return_duration text) cascade;
drop function if exists public.confirm_shipment_status(p_code text, p_status text) cascade;
drop function if exists public.driver_heartbeat(p_driver_id text, p_display_name text, p_phone text, p_vehicle_type text, p_vehicle_label text, p_plate text, p_lat double precision, p_lng double precision, p_heading double precision, p_status text) cascade;
drop function if exists public.enqueue_due_trip_reminders() cascade;
drop function if exists public.expire_stale_drivers() cascade;
drop function if exists public.expire_stale_ride_requests() cascade;
drop function if exists public.find_next_available_trip(p_origin text, p_destination text, p_travel_date date, p_departure_time text, p_max_attempts integer, p_day_horizon integer) cascade;
drop function if exists public.mint_booking_ref() cascade;
drop function if exists public.register_ride_driver(p_driver_id text, p_full_name text, p_phone text, p_vehicle_type text, p_vehicle_label text, p_plate text, p_license_no text, p_national_id text, p_experience_years integer, p_selfie_path text, p_vehicle_photo_path text, p_plate_photo_path text, p_license_photo_path text, p_captured_lat double precision, p_captured_lng double precision) cascade;
drop function if exists public.reject_bus_layout(p_request_id uuid, p_note text) cascade;
drop function if exists public.reject_trip_cancellation(p_request_id bigint, p_note text) cascade;
drop function if exists public.remove_bus_route(p_bus_id text, p_from text, p_to text) cascade;
drop function if exists public.request_trip_cancellation(p_bus_id text, p_travel_date date, p_departure_time text, p_route_from text, p_route_to text, p_reason text) cascade;
drop function if exists public.set_custom_reminder(p_booking_id bigint, p_at timestamp with time zone) cascade;
drop function if exists public.set_default_reminder() cascade;

-- ---------------------------------------------------------------------------
-- 3. handle_payment_completion — rewritten, NOT dropped
--
-- It is the trg_payment_complete trigger on the live payments table, and its
-- booking/reschedule/shipment branches all reference dropped tables. Those
-- branches never fire today (payments.reference_type is only 'booking' on 6
-- legacy rows and 'agent_subscription' on the live ones), and PL/pgSQL does not
-- resolve a table name until the statement runs — which is why payments have
-- kept working.
--
-- It cannot simply be dropped: the `paid_at` default below applies to EVERY
-- payment type, agent subscriptions included. So the dead branches come out and
-- the live behaviour stays.
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
-- 4. RLS: evaluate the admin check ONCE per statement, not once per row
--
-- Postgres re-evaluates a bare is_admin() for every candidate row. is_admin()
-- itself runs `select exists (select 1 from admins where lower(email) = ...)`,
-- which is a sequential scan — hence 5,182 seq scans against a 1-row table.
--
-- Wrapping the call in a scalar subquery turns it into an InitPlan: evaluated
-- once and reused. This is invisible at today's row counts and decisive at
-- 10,000 listings, which is exactly when it would be hardest to diagnose.
--
-- These statements were GENERATED from pg_policies rather than hand-written, so
-- each policy keeps its exact command, roles, permissive/restrictive flag and
-- USING/WITH CHECK expressions; only the function call is wrapped.
-- ---------------------------------------------------------------------------
drop policy if exists "admins read self" on public.admins; create policy "admins read self" on public.admins as permissive for select to public using ((select public.is_admin()));
drop policy if exists "admins write" on public.admins; create policy "admins write" on public.admins as permissive for all to public using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists "agent_actions_log admin all" on public.agent_actions_log; create policy "agent_actions_log admin all" on public.agent_actions_log as permissive for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists "applications read admin" on public.agent_applications; create policy "applications read admin" on public.agent_applications as permissive for select to public using ((select public.is_admin()));
drop policy if exists "applications read tenant" on public.agent_applications; create policy "applications read tenant" on public.agent_applications as permissive for select to authenticated using (((select public.is_admin()) OR (tenant_id IN ( SELECT current_user_tenant_ids() AS current_user_tenant_ids))));
drop policy if exists "applications update admin" on public.agent_applications; create policy "applications update admin" on public.agent_applications as permissive for update to public using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists "applications update tenant" on public.agent_applications; create policy "applications update tenant" on public.agent_applications as permissive for update to authenticated using (((select public.is_admin()) OR (tenant_id IN ( SELECT tu.tenant_id FROM tenant_users tu WHERE (((tu.user_id)::text = ( SELECT app_uid() AS app_uid)) AND (tu.role = ANY (ARRAY['owner'::tenant_role, 'admin'::tenant_role]))))))) with check (((select public.is_admin()) OR (tenant_id IN ( SELECT tu.tenant_id FROM tenant_users tu WHERE (((tu.user_id)::text = ( SELECT app_uid() AS app_uid)) AND (tu.role = ANY (ARRAY['owner'::tenant_role, 'admin'::tenant_role])))))));
drop policy if exists "agent_billing admin read" on public.agent_billing; create policy "agent_billing admin read" on public.agent_billing as permissive for select to public using ((select public.is_admin()));
drop policy if exists "agent_billing admin write" on public.agent_billing; create policy "agent_billing admin write" on public.agent_billing as permissive for all to public using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists "agent_messages admin all" on public.agent_messages; create policy "agent_messages admin all" on public.agent_messages as permissive for all to public using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists "agent_messages self read" on public.agent_messages; create policy "agent_messages self read" on public.agent_messages as permissive for select to public using (((to_user_id = ( SELECT app_uid() AS app_uid)) OR (select public.is_admin())));
drop policy if exists "agent_payments admin read" on public.agent_payments; create policy "agent_payments admin read" on public.agent_payments as permissive for select to public using ((select public.is_admin()));
drop policy if exists "agent_payments admin write" on public.agent_payments; create policy "agent_payments admin write" on public.agent_payments as permissive for all to public using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists "agent_profiles admin write" on public.agent_profiles; create policy "agent_profiles admin write" on public.agent_profiles as permissive for all to public using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists "agent_profiles self read" on public.agent_profiles; create policy "agent_profiles self read" on public.agent_profiles as permissive for select to public using (((user_id = ( SELECT app_uid() AS app_uid)) OR (select public.is_admin())));
drop policy if exists "reviews admin delete" on public.agent_reviews; create policy "reviews admin delete" on public.agent_reviews as permissive for delete to public using ((select public.is_admin()));
drop policy if exists "agents admin write" on public.agents; create policy "agents admin write" on public.agents as permissive for all to public using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists "agents readable" on public.agents; create policy "agents readable" on public.agents as permissive for select to public using (((NOT phone_suspended(phone)) OR (user_id = ( SELECT app_uid() AS app_uid)) OR (select public.is_admin())));
drop policy if exists "agents tenant write" on public.agents; create policy "agents tenant write" on public.agents as permissive for all to authenticated using (((select public.is_admin()) OR (tenant_id IN ( SELECT tu.tenant_id FROM tenant_users tu WHERE (((tu.user_id)::text = ( SELECT app_uid() AS app_uid)) AND (tu.role = ANY (ARRAY['owner'::tenant_role, 'admin'::tenant_role]))))))) with check (((select public.is_admin()) OR (tenant_id IN ( SELECT tu.tenant_id FROM tenant_users tu WHERE (((tu.user_id)::text = ( SELECT app_uid() AS app_uid)) AND (tu.role = ANY (ARRAY['owner'::tenant_role, 'admin'::tenant_role])))))));
drop policy if exists "day_job_claims admin read" on public.day_job_claims; create policy "day_job_claims admin read" on public.day_job_claims as permissive for select to public using ((select public.is_admin()));
drop policy if exists "day_jobs admin delete" on public.day_jobs; create policy "day_jobs admin delete" on public.day_jobs as permissive for delete to public using ((select public.is_admin()));
drop policy if exists "day_jobs admin update" on public.day_jobs; create policy "day_jobs admin update" on public.day_jobs as permissive for update to public using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists "ht admin update" on public.house_tenancies; create policy "ht admin update" on public.house_tenancies as permissive for update to public using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists "ht owner+admin read" on public.house_tenancies; create policy "ht owner+admin read" on public.house_tenancies as permissive for select to public using (((owner_user_id = ( SELECT app_uid() AS app_uid)) OR (select public.is_admin())));
drop policy if exists "houses readable" on public.houses; create policy "houses readable" on public.houses as permissive for select to public using (((NOT uid_suspended(owner_user_id)) OR (owner_user_id = ( SELECT app_uid() AS app_uid)) OR (select public.is_admin())));
drop policy if exists "manager_actions admin all" on public.manager_actions; create policy "manager_actions admin all" on public.manager_actions as permissive for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists finance_select_payments on public.payments; create policy finance_select_payments on public.payments as permissive for select to authenticated using ((select public.is_finance_user()));
drop policy if exists "region_video_defaults admin write" on public.region_video_defaults; create policy "region_video_defaults admin write" on public.region_video_defaults as permissive for all to public using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists "region_videos admin all" on public.region_videos; create policy "region_videos admin all" on public.region_videos as permissive for all to public using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists "services admin write" on public.services; create policy "services admin write" on public.services as permissive for all to public using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists "services readable" on public.services; create policy "services readable" on public.services as permissive for select to public using (((NOT uid_suspended(owner_user_id)) OR (owner_user_id = ( SELECT app_uid() AS app_uid)) OR (select public.is_admin())));
drop policy if exists "tenant_settings owner write" on public.tenant_settings; create policy "tenant_settings owner write" on public.tenant_settings as permissive for all to authenticated using (((select public.is_super_admin()) OR (EXISTS ( SELECT 1 FROM tenant_users tu WHERE ((tu.tenant_id = tenant_settings.tenant_id) AND ((tu.user_id)::text = ( SELECT app_uid() AS app_uid)) AND (tu.role = ANY (ARRAY['owner'::tenant_role, 'admin'::tenant_role]))))))) with check (((select public.is_super_admin()) OR (EXISTS ( SELECT 1 FROM tenant_users tu WHERE ((tu.tenant_id = tenant_settings.tenant_id) AND ((tu.user_id)::text = ( SELECT app_uid() AS app_uid)) AND (tu.role = ANY (ARRAY['owner'::tenant_role, 'admin'::tenant_role])))))));
drop policy if exists "tenant_settings read" on public.tenant_settings; create policy "tenant_settings read" on public.tenant_settings as permissive for select to authenticated using (((select public.is_super_admin()) OR (tenant_id IN ( SELECT current_user_tenant_ids() AS current_user_tenant_ids))));
drop policy if exists "tenant_users owner write" on public.tenant_users; create policy "tenant_users owner write" on public.tenant_users as permissive for all to authenticated using (((select public.is_super_admin()) OR (EXISTS ( SELECT 1 FROM tenants t WHERE ((t.id = tenant_users.tenant_id) AND ((t.owner_user_id)::text = ( SELECT app_uid() AS app_uid))))))) with check (((select public.is_super_admin()) OR (EXISTS ( SELECT 1 FROM tenants t WHERE ((t.id = tenant_users.tenant_id) AND ((t.owner_user_id)::text = ( SELECT app_uid() AS app_uid)))))));
drop policy if exists "tenant_users self read" on public.tenant_users; create policy "tenant_users self read" on public.tenant_users as permissive for select to authenticated using (((select public.is_super_admin()) OR ((user_id)::text = ( SELECT app_uid() AS app_uid)) OR (tenant_id IN ( SELECT current_user_tenant_ids() AS current_user_tenant_ids))));
drop policy if exists "tenant admin delete" on public.tenants; create policy "tenant admin delete" on public.tenants as permissive for delete to authenticated using ((select public.is_admin()));
drop policy if exists "tenant members read" on public.tenants; create policy "tenant members read" on public.tenants as permissive for select to authenticated using (((select public.is_super_admin()) OR (id IN ( SELECT current_user_tenant_ids() AS current_user_tenant_ids))));
drop policy if exists "tenant owner update" on public.tenants; create policy "tenant owner update" on public.tenants as permissive for update to authenticated using ((((owner_user_id)::text = ( SELECT app_uid() AS app_uid)) OR (select public.is_super_admin()))) with check ((((owner_user_id)::text = ( SELECT app_uid() AS app_uid)) OR (select public.is_super_admin())));
drop policy if exists "trucks admin write" on public.trucks; create policy "trucks admin write" on public.trucks as permissive for all to public using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists "trucks readable" on public.trucks; create policy "trucks readable" on public.trucks as permissive for select to public using (((NOT uid_suspended(owner_user_id)) OR (owner_user_id = ( SELECT app_uid() AS app_uid)) OR (select public.is_admin())));
-- (40 policies rewritten)

-- ---------------------------------------------------------------------------
-- 5. Indexes
--
-- Deliberately NOT removing the 60-odd "never used" indexes on houses, trucks,
-- services and house_demand_pins. They read as unused because those tables hold
-- ONE row each — Postgres will always prefer a sequential scan at that size, so
-- idx_scan = 0 means "no data yet", not "useless index". They are the indexes
-- those queries will need the moment real listings arrive, and clearing them
-- now would only mean recreating them later.
--
-- What IS worth changing:

-- is_admin() matches on lower(email) with no matching index, so every call
-- sequentially scans admins. Cheap now, and the fix is one line.
create index if not exists admins_lower_email_idx on public.admins (lower(email));

-- hdp_region_idx is a strict prefix of hdp_region_district_idx, so the planner
-- can serve every query the narrow one covers from the wider one. This is the
-- only genuinely redundant index in the schema.
drop index if exists public.hdp_region_idx;

-- ---------------------------------------------------------------------------
-- 6. Parallel safety
--
-- These are all STABLE and read-only, but default to PARALLEL UNSAFE, which
-- blocks a parallel plan on any query whose RLS policy calls them — including
-- the public listing reads on houses / trucks / services. Marking them safe
-- costs nothing and stops that whole class of plan from being ruled out.
-- ---------------------------------------------------------------------------
alter function public.is_admin()                parallel safe;
alter function public.app_uid()                 parallel safe;
alter function public.uid_suspended(text)       parallel safe;
alter function public.agent_key_suspended(text) parallel safe;

commit;

-- ---------------------------------------------------------------------------
-- Deliberately left alone — judgement calls, not oversights
--
-- approve_agent_application() also references the dropped `buses` table, but
-- the agent system around it is live (agent_profiles and agent_billing both
-- hold rows). It has no caller today, so it is dormant rather than broken.
-- Removing it is a product decision about whether agent applications come back.
--
-- `houses readable` / `trucks readable` / `services readable` call
-- uid_suspended(owner_user_id). That takes a per-row argument, so unlike
-- is_admin() it CANNOT be hoisted out of the loop — every listing row costs one
-- suspension lookup on the hottest public path in the app. It is correct and
-- cheap at current volume. If listings reach the thousands, the fix is to stop
-- asking per row: keep a suspended-owner set, or denormalise a `suspended` flag
-- onto the listing and index it. That is a schema change, not a tuning tweak,
-- so it is flagged here rather than done.
-- ---------------------------------------------------------------------------
