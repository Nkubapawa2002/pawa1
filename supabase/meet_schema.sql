-- =====================================================================
-- Pawa Bus Cargo — Meet & Locate (live GPS rooms)
-- Schema for Uber-style realtime meet-up: 2+ users share GPS in a room.
-- Run in Supabase SQL Editor.
-- =====================================================================

-- ----- 1. meet_rooms ------------------------------------------------
-- A short-lived private room with a 6-char join code.
create table if not exists public.meet_rooms (
  id              uuid primary key default gen_random_uuid(),
  code            text unique not null,
  purpose         text default 'meet' check (purpose in ('meet','delivery','pickup','handoff')),
  tracking_code   text,                      -- optional: links to a shipment / booking
  created_by      text,                      -- phone or name
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null default (now() + interval '6 hours'),
  status          text not null default 'active' check (status in ('active','closed','expired'))
);

create index if not exists meet_rooms_code_idx    on public.meet_rooms (code);
create index if not exists meet_rooms_status_idx  on public.meet_rooms (status, expires_at);

-- ----- 2. live_locations -------------------------------------------
-- One row per active sharer per room (upserted on every GPS tick).
create table if not exists public.live_locations (
  id              bigserial primary key,
  room_code       text not null references public.meet_rooms(code) on delete cascade,
  user_id         text not null,             -- client-generated UUID stored in localStorage
  display_name    text,
  phone           text,
  role            text default 'guest' check (role in ('sender','receiver','driver','agent','guest')),
  lat             double precision not null,
  lng             double precision not null,
  accuracy_m      double precision,
  heading         double precision,          -- degrees, 0=N
  speed_mps       double precision,
  battery_pct     int,
  status_text     text,                       -- "I'm here", "5 min away", etc.
  last_seen       timestamptz not null default now(),
  unique (room_code, user_id)
);

create index if not exists live_locations_room_idx
  on public.live_locations (room_code, last_seen desc);

-- ----- 3. Touch trigger --------------------------------------------
create or replace function public.touch_live_location()
returns trigger as $$
begin
  new.last_seen := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_live_loc_touch on public.live_locations;
create trigger trg_live_loc_touch
  before update on public.live_locations
  for each row execute function public.touch_live_location();

-- ----- 4. Auto-expire stale rooms (call from cron / edge function) -
create or replace function public.expire_meet_rooms()
returns void as $$
begin
  update public.meet_rooms
     set status = 'expired'
   where status = 'active'
     and expires_at < now();
end;
$$ language plpgsql;

-- ----- 5. RLS -------------------------------------------------------
alter table public.meet_rooms      enable row level security;
alter table public.live_locations  enable row level security;

-- Anyone with the room code can read the room and its locations.
-- (The code itself is the access control — keep it secret.)
drop policy if exists "anon_read_rooms" on public.meet_rooms;
create policy "anon_read_rooms"
  on public.meet_rooms for select to anon, authenticated using (true);

drop policy if exists "anon_create_rooms" on public.meet_rooms;
create policy "anon_create_rooms"
  on public.meet_rooms for insert to anon, authenticated with check (true);

drop policy if exists "anon_update_own_room" on public.meet_rooms;
create policy "anon_update_own_room"
  on public.meet_rooms for update to anon, authenticated using (true) with check (true);

drop policy if exists "anon_read_locations" on public.live_locations;
create policy "anon_read_locations"
  on public.live_locations for select to anon, authenticated using (true);

drop policy if exists "anon_write_locations" on public.live_locations;
create policy "anon_write_locations"
  on public.live_locations for insert to anon, authenticated with check (true);

drop policy if exists "anon_update_own_location" on public.live_locations;
create policy "anon_update_own_location"
  on public.live_locations for update to anon, authenticated using (true) with check (true);

drop policy if exists "anon_delete_own_location" on public.live_locations;
create policy "anon_delete_own_location"
  on public.live_locations for delete to anon, authenticated using (true);

-- ----- 6. Realtime publication -------------------------------------
do $$ begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'live_locations'
  ) then
    alter publication supabase_realtime add table public.live_locations;
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'meet_rooms'
  ) then
    alter publication supabase_realtime add table public.meet_rooms;
  end if;
end $$;
