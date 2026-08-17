-- Ride-hailing: make the live map + realtime correct, schedule cleanup, and
-- remove redundant RLS policies. Pure DB-layer fixes (SQL is the right tool;
-- Supabase Realtime already does the GPS fan-out, so no extra service needed).
--
-- Idempotent. Safe to re-run.

-- ===========================================================================
-- 1. REPLICA IDENTITY FULL — so realtime UPDATE/DELETE events include the FULL
--    "old" row, not just the primary key.
--
--    js/ride.js relies on the old row:
--      * onRideRequestUpdateStream(): `if (old.status === r.status) return;`
--        — with PK-only old, old.status is undefined, so EVERY ride_requests
--        update fired a duplicate ticker event. FULL fixes the de-dup.
--      * onDriverUpdate(): old.lat/lng (moved?) + old.status (went busy).
-- ===========================================================================
alter table public.drivers_online replica identity full;
alter table public.ride_requests  replica identity full;

-- ===========================================================================
-- 2. Schedule the stale-row cleanup (pg_cron is installed). Without this,
--    drivers_online keeps stale "online" rows and ride_requests keeps
--    abandoned requests forever. The client already hides >90 s-stale drivers,
--    but the server should reap them too. cron.schedule(name,…) replaces by name.
-- ===========================================================================
select cron.schedule('pawa_expire_drivers',       '* * * * *', 'select public.expire_stale_drivers();');
select cron.schedule('pawa_expire_ride_requests', '* * * * *', 'select public.expire_stale_ride_requests();');

-- ===========================================================================
-- 3. Remove redundant duplicate policies. Each ride table had a broad
--    "public ALL/insert/read/update" policy duplicating the granular
--    anon/authenticated policies — same effective access, just clutter.
--    Keep the explicit anon/authenticated policies; drop the duplicates.
-- ===========================================================================
drop policy if exists "ride_drivers public insert" on public.ride_drivers;
drop policy if exists "ride_drivers public read"   on public.ride_drivers;
drop policy if exists "ride_drivers public update" on public.ride_drivers;

drop policy if exists "drivers_online public all"  on public.drivers_online;

drop policy if exists "ride_requests public all"   on public.ride_requests;

drop policy if exists "ride_messages public all"   on public.ride_messages;
