-- ============================================================================
-- security_hardening.sql — close anon data leaks found by the 2026-06-04 audit
-- ============================================================================
-- Run in the Supabase SQL editor. Section 1 is SAFE to apply now (it only
-- re-asserts what schema_master.sql already intends). Sections 2–3 are
-- RECOMMENDED but may affect the public no-login flows (parcel tracking,
-- booking, meet/ride) — read the notes and test before enabling.
--
-- How the leaks were found: querying each table with the PUBLIC anon key
-- (which is subject to RLS). Tables that returned rows to anon are readable
-- by anyone on the internet who has the publishable key (it ships in the
-- frontend, so: everyone).
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. call_requests — SAFE FIX (schema drift)
-- ----------------------------------------------------------------------------
-- Audit found anon could read 55 rows incl. phone numbers, but schema_master
-- already intends admin-only reads. The live DB drifted to a permissive
-- policy (or RLS was off). This re-asserts the intended state. The app only
-- ever reads call_requests from the admin panel (authenticated), so this is
-- safe to apply immediately.
alter table public.call_requests enable row level security;

-- Drop EVERY existing policy on the table by name (the leaky one may be named
-- anything, e.g. Supabase's default "Enable read access for all users"), so we
-- start from a clean slate instead of guessing names.
do $$
declare pol record;
begin
  for pol in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'call_requests'
  loop
    execute format('drop policy if exists %I on public.call_requests', pol.policyname);
  end loop;
end $$;

create policy "call_requests public insert" on public.call_requests
  for insert with check (true);                       -- callers can request a callback
create policy "call_requests admin read" on public.call_requests
  for select using (public.is_admin());               -- only admins see phone numbers
create policy "call_requests admin update" on public.call_requests
  for update using (public.is_admin()) with check (public.is_admin());


-- ----------------------------------------------------------------------------
-- 2. shipments / bookings — STOP ANON TAMPERING (recommended)
-- ----------------------------------------------------------------------------
-- The dangerous part is UPDATE using(true): anyone can modify ANY shipment or
-- booking (e.g. flip status to "Delivered", change a fare). Inserts stay open
-- (the public send/book pages create rows without login). Updates should be
-- admin-only; the admin panel runs authenticated and n8n uses the service_role
-- key, both of which bypass this. ONLY enable if no public page updates these
-- rows anonymously (verify book-fast.js seat-hold release first).
--
--   alter table public.shipments enable row level security;
--   drop policy if exists "shipments updatable" on public.shipments;
--   create policy "shipments admin update" on public.shipments
--     for update using (public.is_admin()) with check (public.is_admin());
--
--   alter table public.bookings enable row level security;
--   drop policy if exists "bookings public update" on public.bookings;
--   create policy "bookings admin update" on public.bookings
--     for update using (public.is_admin()) with check (public.is_admin());
--
-- Reads (using(true)) stay open for now because track.html / ticket pages look
-- rows up anonymously. The PROPER fix is a SECURITY DEFINER function
-- get_shipment(code) / get_booking(code) that returns a single row by code,
-- then restrict table SELECT to admins. That removes "dump the whole table"
-- while keeping tracking-by-code working. Ask and I'll build it.


-- ----------------------------------------------------------------------------
-- 3. ride_drivers / live_locations / meet_rooms — privacy (recommended)
-- ----------------------------------------------------------------------------
-- ride_drivers UPDATE using(true) lets anyone edit any driver row — tighten to
-- the owning driver or admin:
--   drop policy if exists "ride_drivers public update" on public.ride_drivers;
--   create policy "ride_drivers self update" on public.ride_drivers
--     for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
--
-- live_locations exposes real GPS coordinates to anon. These are ephemeral and
-- room-scoped; the robust fix is to require the room_code as a filter via an
-- RPC rather than open table reads. Flag for the meet/ride flow review.
