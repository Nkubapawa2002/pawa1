-- ============================================================================
-- remove_legacy_features.sql — drop the retired bus / ride / parcel / reminder
-- features for the production housing app.
-- ============================================================================
-- These are the pre-pivot consumer features that are no longer offered. Audit
-- (scripts/db_spider.mjs) confirmed the set is self-contained: NO function
-- references them and NO current table has a foreign key into them, so dropping
-- is safe and won't cascade into the live housing/services/jobs data.
--
-- Data was exported first to backup_legacy_busridepostal_2026-06-20.json.
-- KEPT (not bus/ride/parcel): tenants + accounting (payments, payment_callbacks,
-- pending_changes, tax_rates, org_*, ledger_*, manager_actions), meet_rooms +
-- live_locations (current share-location feature), agents/agent_* (agent system).
--
-- Idempotent. Paste into the Supabase SQL editor and Run.
-- ============================================================================
begin;

-- Ride (drop dependents first; CASCADE covers internal FKs either way)
drop table if exists public.ride_messages            cascade;
drop table if exists public.ride_requests            cascade;
drop table if exists public.drivers_online           cascade;
drop table if exists public.ride_drivers             cascade;
drop table if exists public.trip_cancellation_requests cascade;
drop table if exists public.cash_retargets           cascade;

-- Parcel
drop table if exists public.shipment_messages        cascade;
drop table if exists public.shipments                cascade;
drop table if exists public.parcel_quotes            cascade;

-- Reminders + booking-time comms
drop table if exists public.trip_reminders           cascade;
drop table if exists public.scheduled_reminders      cascade;
drop table if exists public.call_requests            cascade;
drop table if exists public.message_log              cascade;

-- Bus
drop table if exists public.bus_layout_pending       cascade;
drop table if exists public.book_adjustments         cascade;
drop table if exists public.bookings                 cascade;
drop table if exists public.buses                    cascade;

commit;

-- ============================================================================
-- Done. Verify these 17 tables are gone and the housing app tables remain.
-- ============================================================================
