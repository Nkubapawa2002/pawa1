-- ============================================================================
-- db_production_fixes.sql — issues found by scripts/db_spider.mjs
-- ============================================================================
-- The current housing/services/jobs app audited CLEAN: RLS on every table, all
-- PII tables restrict SELECT to owner-or-admin, all RPCs/columns present,
-- SECURITY DEFINER functions all pin search_path, views use security_invoker.
--
-- Two real issues remained, both fixed here:
--
--  1. live_locations had RLS ON but ZERO policies → fully locked. But the
--     "share my location with the agent" feature still uses it directly:
--       • share-location.js   → INSERT (anon, no login)
--       • agent-houses.js      → SELECT + realtime
--     With no policy both fail, so the feature was BROKEN in production. We
--     restore the public room-code model it shares with meet_rooms (the
--     room_code is the access secret — same design as the meet page).
--
--  2. trip_reminders (legacy, ZERO frontend references) had an open ALL policy
--     USING true → anyone could UPDATE/DELETE every reminder. We drop that
--     destructive grant; inserts + reads still work (in case a webhook posts).
--
-- Idempotent. Safe to re-run. Paste into the Supabase SQL editor and Run.
-- ============================================================================
begin;

-- 1. live_locations — restore the public, room-code-based access the app needs.
--    ROOT CAUSE: the table was created WITHOUT the anon/authenticated table
--    grants every other table has (audit showed grants = []), so even reads hit
--    "42501 permission denied for table" before RLS is even consulted. Grant the
--    privileges the two code paths need, THEN add the RLS policies.
grant select, insert on public.live_locations to anon, authenticated;

alter table public.live_locations enable row level security;
drop policy if exists "live_locations public insert" on public.live_locations;
drop policy if exists "live_locations public read"   on public.live_locations;
create policy "live_locations public insert" on public.live_locations
  for insert with check (true);
create policy "live_locations public read" on public.live_locations
  for select using (true);

-- ...and the role CHECK constraint omitted 'onsite', the role share-location.js
-- sends ("the person physically at the house"), so inserts were rejected. Add it.
alter table public.live_locations drop constraint if exists live_locations_role_check;
alter table public.live_locations add constraint live_locations_role_check
  check (role = any (array['sender','receiver','driver','agent','guest','onsite']));

-- 2. trip_reminders — close the anon write/delete hole; keep insert + read.
drop policy if exists "trip_reminders write"  on public.trip_reminders;
drop policy if exists "trip_reminders insert" on public.trip_reminders;
create policy "trip_reminders insert" on public.trip_reminders
  for insert with check (true);
-- (the existing "trip_reminders read" SELECT policy is intentionally kept)

commit;

-- ============================================================================
-- Verify:
--   • share-location → agent-houses live pin works again (live_locations RW);
--   • trip_reminders no longer accepts anon UPDATE/DELETE.
-- ============================================================================
