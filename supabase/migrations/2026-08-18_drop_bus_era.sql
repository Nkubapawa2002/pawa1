-- ============================================================================
-- Bus-era removals. The DESTRUCTIVE half of the 2026-08-18 audit.
--
-- The tuning half (RLS hoisting, the admins index, PARALLEL SAFE, the
-- handle_payment_completion rewrite) was applied on 2026-08-18 as
-- 2026-08-18_rls_and_index_tuning.sql. Nothing in that file is repeated here.
--
-- Context: the product pivoted from bus ticketing to the housing / trucks /
-- services / day-jobs marketplace, and commit 44e66c5 deleted the pages. The
-- bus TABLES were already gone from this database; what survived was the code
-- that referenced them.
--
-- Everything here was verified unreferenced by: the frontend (js/, *.html), the
-- edge functions, every other SQL function body, all views, and all foreign
-- keys. Row data for the dropped tables is preserved in
-- docs/db-cleanup/dropped-tables-data.json (18 rows).
--
-- Idempotent. Safe to re-run.
--
-- Apply:  Supabase Dashboard -> SQL Editor -> paste -> Run
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Orphaned finance tables (the accounting.html portal, deleted in the pivot)
--
-- tax_rates described itself as applying to "bus tickets and cargo". Their RLS
-- policies are the only ones still calling an unhoisted is_finance_user() /
-- is_super_admin(); they are deliberately left unfixed because they disappear
-- with their tables here.
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
-- Each references at least one dropped bus-era table, so it cannot execute
-- successfully. Three were still scheduled in pg_cron and had been failing
-- every minute since the pivot (~4,300 errors a day); those jobs were
-- unscheduled on 2026-08-18 and their definitions kept in
-- docs/db-cleanup/removed-cron-jobs.txt.
--
-- Signatures are spelled out because several of these names are overloaded.
--
-- NOTE: handle_payment_completion is NOT in this list. It is the live
-- trg_payment_complete trigger on payments and was rewritten in the tuning
-- migration instead — its paid_at stamp applies to every payment type.
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
-- 3. The one genuinely redundant index
--
-- hdp_region_idx is a strict prefix of hdp_region_district_idx, so the planner
-- can serve from the wider index everything the narrow one covers.
--
-- The ~60 other zero-scan indexes on houses / trucks / services are NOT touched
-- here. They read as unused because those tables hold ONE row each and Postgres
-- always prefers a sequential scan at that size: idx_scan = 0 means "no data
-- yet", not "dead index". They are what those queries will need once real
-- listings arrive.
-- ---------------------------------------------------------------------------
drop index if exists public.hdp_region_idx;

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
-- uid_suspended(owner_user_id). That argument is per-row, so unlike is_admin()
-- it CANNOT be hoisted out of the loop — every listing row costs one suspension
-- lookup, on the hottest public path in the app. Correct and cheap at current
-- volume. If listings reach the thousands the fix is to stop asking per row:
-- keep a suspended-owner set, or denormalise an indexed `suspended` flag onto
-- the listing. That is a schema change, not a tuning tweak.
-- ---------------------------------------------------------------------------
