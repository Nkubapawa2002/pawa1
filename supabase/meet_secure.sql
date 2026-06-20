-- =====================================================================
-- meet_secure.sql — close the live_locations PII leak.
--
-- BEFORE: live_locations had policies `USING (true)` for anon/public, so the
-- public anon key could read (and modify/delete) EVERY row — names, phone
-- numbers and live GPS of every active sharer, across all rooms.
--
-- AFTER: no direct table access. All reads/writes go through SECURITY DEFINER
-- RPCs that require the room_code (the shared-link capability). You can only see
-- a room's peers if you know its code, and you can only touch your own row
-- (room_code + your client-generated user_id). RLS stays ON with zero policies,
-- so direct REST/realtime access is denied; the RPCs bypass RLS by design.
--
-- Idempotent + transactional. Safe to re-run.  Run with scripts/run_sql.mjs.
-- =====================================================================
begin;

-- ---- Reads: only the peers in a room you have the code for ------------------
create or replace function public.meet_room_peers(p_code text)
returns setof public.live_locations
language sql security definer set search_path = public stable
as $$
  select * from public.live_locations
  where p_code is not null and p_code <> '' and room_code = p_code
$$;

-- ---- Write: upsert YOUR OWN presence/location row ---------------------------
-- coalesce() on every field except last_seen so a status-only update doesn't
-- wipe your location, and a location update doesn't wipe your name/phone.
create or replace function public.meet_upsert_presence(
  p_code text, p_user_id text,
  p_name text default null, p_phone text default null, p_role text default null,
  p_lat double precision default null, p_lng double precision default null,
  p_accuracy_m double precision default null, p_heading double precision default null,
  p_speed_mps double precision default null, p_battery_pct integer default null,
  p_status_text text default null
) returns void
language sql security definer set search_path = public
as $$
  insert into public.live_locations
    (room_code, user_id, display_name, phone, role, lat, lng, accuracy_m,
     heading, speed_mps, battery_pct, status_text, last_seen)
  values
    (p_code, p_user_id, p_name, p_phone, p_role, p_lat, p_lng, p_accuracy_m,
     p_heading, p_speed_mps, p_battery_pct, p_status_text, now())
  on conflict (room_code, user_id) do update set
    display_name = coalesce(excluded.display_name, live_locations.display_name),
    phone        = coalesce(excluded.phone,        live_locations.phone),
    role         = coalesce(excluded.role,         live_locations.role),
    lat          = coalesce(excluded.lat,          live_locations.lat),
    lng          = coalesce(excluded.lng,          live_locations.lng),
    accuracy_m   = coalesce(excluded.accuracy_m,   live_locations.accuracy_m),
    heading      = coalesce(excluded.heading,      live_locations.heading),
    speed_mps    = coalesce(excluded.speed_mps,    live_locations.speed_mps),
    battery_pct  = coalesce(excluded.battery_pct,  live_locations.battery_pct),
    status_text  = coalesce(excluded.status_text,  live_locations.status_text),
    last_seen    = now()
$$;

-- ---- Leave: delete YOUR OWN row --------------------------------------------
create or replace function public.meet_leave(p_code text, p_user_id text)
returns void
language sql security definer set search_path = public
as $$
  delete from public.live_locations where room_code = p_code and user_id = p_user_id
$$;

-- ---- Lock the table: drop the wide-open policies; deny direct access --------
drop policy if exists "anon_read_locations"      on public.live_locations;
drop policy if exists "anon_write_locations"     on public.live_locations;
drop policy if exists "anon_update_own_location" on public.live_locations;
drop policy if exists "anon_delete_own_location" on public.live_locations;
drop policy if exists "live_locations public all" on public.live_locations;
-- RLS remains enabled; with no policies, direct REST/realtime access is denied.
alter table public.live_locations enable row level security;

revoke all on public.live_locations from anon, authenticated;
grant execute on function public.meet_room_peers(text) to anon, authenticated;
grant execute on function public.meet_upsert_presence(
  text, text, text, text, text, double precision, double precision,
  double precision, double precision, double precision, integer, text
) to anon, authenticated;
grant execute on function public.meet_leave(text, text) to anon, authenticated;

commit;
