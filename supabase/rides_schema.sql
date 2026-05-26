-- =====================================================================
-- Pawa Bus Cargo — Uber-style Ride Hailing for Tanzania
--
-- Two main tables:
--   drivers_online   — drivers with their live position + status
--   ride_requests    — a single trip request from rider to dropoff
--
-- Wired to Supabase Realtime so riders see drivers move and drivers see
-- new pings instantly. RLS is open to anon (the access control is the
-- request id and the assigned driver_id), matching the rest of the app.
--
-- Run after meet_schema.sql + payments_schema.sql.
-- =====================================================================

-- ----- 1. drivers_online ---------------------------------------------
create table if not exists public.drivers_online (
  driver_id     text primary key,                  -- client-generated UUID
  display_name  text not null,
  phone         text,
  vehicle_type  text default 'car' check (vehicle_type in ('car','bajaj','bodaboda','van','pickup')),
  vehicle_label text,                               -- "Toyota IST · T123 ABC"
  plate         text,
  rating        numeric(3,2) default 4.80,
  trips_done    int          default 0,
  lat           double precision not null,
  lng           double precision not null,
  heading       double precision,
  status        text not null default 'online'
                   check (status in ('online','busy','offline')),
  last_seen     timestamptz not null default now()
);

create index if not exists drivers_online_status_idx
  on public.drivers_online (status, last_seen desc);
-- A simple geo index — coarse but fine for Tanzania-scale lookups.
create index if not exists drivers_online_lat_lng_idx
  on public.drivers_online (lat, lng);

-- ----- 2. ride_requests ----------------------------------------------
create table if not exists public.ride_requests (
  id              uuid primary key default gen_random_uuid(),
  rider_id        text not null,
  rider_name      text,
  rider_phone     text,

  pickup_lat      double precision not null,
  pickup_lng      double precision not null,
  pickup_addr     text,

  dropoff_lat     double precision not null,
  dropoff_lng     double precision not null,
  dropoff_addr    text,

  vehicle_type    text default 'car' check (vehicle_type in ('car','bajaj','bodaboda','van','pickup')),
  notes           text,
  is_friend_meet  boolean default false,           -- "I just want to meet a friend, no driver"

  distance_km     numeric(7,2),
  fare_tzs        int,

  -- Lifecycle: requested → accepted → en_route_pickup → arrived
  --           → on_trip → completed | cancelled | expired
  status          text not null default 'requested'
                   check (status in (
                     'requested','accepted','en_route_pickup','arrived',
                     'on_trip','completed','cancelled','expired'
                   )),

  driver_id       text references public.drivers_online(driver_id) on delete set null,
  driver_name     text,
  driver_phone    text,
  driver_vehicle  text,
  driver_plate    text,

  -- Live driver fix while the trip is in progress
  driver_lat      double precision,
  driver_lng      double precision,
  driver_heading  double precision,
  driver_seen_at  timestamptz,

  payment_id      uuid,                             -- payments.id once paid
  payment_status  text,                             -- mirror of payments.status

  requested_at    timestamptz not null default now(),
  accepted_at     timestamptz,
  arrived_at      timestamptz,
  started_at      timestamptz,
  completed_at    timestamptz,
  cancelled_at    timestamptz,
  cancelled_by    text                              -- 'rider' | 'driver' | 'system'
);

create index if not exists ride_requests_status_idx
  on public.ride_requests (status, requested_at desc);
create index if not exists ride_requests_rider_idx
  on public.ride_requests (rider_id, requested_at desc);
create index if not exists ride_requests_driver_idx
  on public.ride_requests (driver_id, requested_at desc);
create index if not exists ride_requests_open_idx
  on public.ride_requests (status, pickup_lat, pickup_lng)
  where status = 'requested';

-- ----- 3. Driver heartbeat helper ------------------------------------
-- Drivers call this every ~5 s while online so stale rows can be pruned.
create or replace function public.driver_heartbeat(
  p_driver_id    text,
  p_display_name text,
  p_phone        text,
  p_vehicle_type text,
  p_vehicle_label text,
  p_plate        text,
  p_lat          double precision,
  p_lng          double precision,
  p_heading      double precision,
  p_status       text
) returns void as $$
begin
  insert into public.drivers_online (
    driver_id, display_name, phone, vehicle_type, vehicle_label, plate,
    lat, lng, heading, status, last_seen
  ) values (
    p_driver_id, p_display_name, p_phone, p_vehicle_type, p_vehicle_label, p_plate,
    p_lat, p_lng, p_heading, p_status, now()
  )
  on conflict (driver_id) do update set
    display_name  = excluded.display_name,
    phone         = excluded.phone,
    vehicle_type  = excluded.vehicle_type,
    vehicle_label = excluded.vehicle_label,
    plate         = excluded.plate,
    lat           = excluded.lat,
    lng           = excluded.lng,
    heading       = excluded.heading,
    status        = excluded.status,
    last_seen     = now();
end;
$$ language plpgsql security definer;

-- Mark drivers offline if they haven't pinged in 90 s (cron job).
create or replace function public.expire_stale_drivers()
returns void as $$
begin
  update public.drivers_online
     set status = 'offline'
   where status <> 'offline'
     and last_seen < now() - interval '90 seconds';
end;
$$ language plpgsql;

-- Cancel ride requests that nobody accepted within 5 minutes.
create or replace function public.expire_stale_ride_requests()
returns void as $$
begin
  update public.ride_requests
     set status = 'expired'
   where status = 'requested'
     and requested_at < now() - interval '5 minutes';
end;
$$ language plpgsql;

-- ----- 4. RLS --------------------------------------------------------
alter table public.drivers_online enable row level security;
alter table public.ride_requests  enable row level security;

drop policy if exists "anon_read_drivers"   on public.drivers_online;
create policy "anon_read_drivers"
  on public.drivers_online for select to anon, authenticated using (true);

drop policy if exists "anon_write_drivers"  on public.drivers_online;
create policy "anon_write_drivers"
  on public.drivers_online for insert to anon, authenticated with check (true);

drop policy if exists "anon_update_drivers" on public.drivers_online;
create policy "anon_update_drivers"
  on public.drivers_online for update to anon, authenticated using (true) with check (true);

drop policy if exists "anon_delete_drivers" on public.drivers_online;
create policy "anon_delete_drivers"
  on public.drivers_online for delete to anon, authenticated using (true);

drop policy if exists "anon_read_rides"   on public.ride_requests;
create policy "anon_read_rides"
  on public.ride_requests for select to anon, authenticated using (true);

drop policy if exists "anon_write_rides"  on public.ride_requests;
create policy "anon_write_rides"
  on public.ride_requests for insert to anon, authenticated with check (true);

drop policy if exists "anon_update_rides" on public.ride_requests;
create policy "anon_update_rides"
  on public.ride_requests for update to anon, authenticated using (true) with check (true);

-- ----- 4b. ride_drivers — persistent KYC profile for live-capture ---
-- The drivers_online table is ephemeral presence (gets pruned when stale).
-- ride_drivers is the durable profile created during the live capture flow:
-- selfie + vehicle photo + plate photo + license photo all uploaded to the
-- public bucket "ride-driver-photos" (create it in Storage > New bucket).
create table if not exists public.ride_drivers (
  driver_id          text primary key,
  full_name          text not null,
  phone              text not null,
  vehicle_type       text not null check (vehicle_type in ('car','bajaj','bodaboda','van','pickup')),
  vehicle_label      text,
  plate              text not null,
  license_no         text,
  national_id        text,
  experience_years   int  not null default 1 check (experience_years >= 0),

  -- Photos uploaded during live capture (relative paths in the bucket)
  selfie_path        text not null,
  vehicle_photo_path text not null,
  plate_photo_path   text not null,
  license_photo_path text,

  -- Where the driver was sitting when they registered — proof-of-location
  captured_lat       double precision,
  captured_lng       double precision,
  captured_at        timestamptz not null default now(),

  verified           boolean not null default false,
  rating_avg         numeric(3,2) not null default 4.80,
  trips_done         int not null default 0,
  banned             boolean not null default false,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create unique index if not exists ride_drivers_phone_idx on public.ride_drivers (phone);
create unique index if not exists ride_drivers_plate_idx on public.ride_drivers (plate);
create index        if not exists ride_drivers_vehicle_idx on public.ride_drivers (vehicle_type, verified);

-- Touch updated_at on every change
create or replace function public.touch_ride_drivers() returns trigger
language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;
drop trigger if exists trg_ride_drivers_touch on public.ride_drivers;
create trigger trg_ride_drivers_touch before update on public.ride_drivers
  for each row execute function public.touch_ride_drivers();

-- One-shot upsert used by the live-capture form. Returns the driver_id.
create or replace function public.register_ride_driver(
  p_driver_id          text,
  p_full_name          text,
  p_phone              text,
  p_vehicle_type       text,
  p_vehicle_label      text,
  p_plate              text,
  p_license_no         text,
  p_national_id        text,
  p_experience_years   int,
  p_selfie_path        text,
  p_vehicle_photo_path text,
  p_plate_photo_path   text,
  p_license_photo_path text,
  p_captured_lat       double precision,
  p_captured_lng       double precision
) returns text language plpgsql security definer set search_path = public as $$
begin
  insert into public.ride_drivers (
    driver_id, full_name, phone, vehicle_type, vehicle_label, plate,
    license_no, national_id, experience_years,
    selfie_path, vehicle_photo_path, plate_photo_path, license_photo_path,
    captured_lat, captured_lng
  ) values (
    p_driver_id, p_full_name, p_phone, p_vehicle_type, p_vehicle_label, upper(p_plate),
    p_license_no, p_national_id, coalesce(p_experience_years, 1),
    p_selfie_path, p_vehicle_photo_path, p_plate_photo_path, p_license_photo_path,
    p_captured_lat, p_captured_lng
  )
  on conflict (driver_id) do update set
    full_name          = excluded.full_name,
    phone              = excluded.phone,
    vehicle_type       = excluded.vehicle_type,
    vehicle_label      = excluded.vehicle_label,
    plate              = excluded.plate,
    license_no         = excluded.license_no,
    national_id        = excluded.national_id,
    experience_years   = excluded.experience_years,
    selfie_path        = excluded.selfie_path,
    vehicle_photo_path = excluded.vehicle_photo_path,
    plate_photo_path   = excluded.plate_photo_path,
    license_photo_path = coalesce(excluded.license_photo_path, public.ride_drivers.license_photo_path),
    captured_lat       = excluded.captured_lat,
    captured_lng       = excluded.captured_lng;
  return p_driver_id;
end;
$$;

alter table public.ride_drivers enable row level security;

drop policy if exists "anon_read_ride_drivers"   on public.ride_drivers;
create policy "anon_read_ride_drivers"
  on public.ride_drivers for select to anon, authenticated using (true);

drop policy if exists "anon_insert_ride_drivers" on public.ride_drivers;
create policy "anon_insert_ride_drivers"
  on public.ride_drivers for insert to anon, authenticated with check (true);

drop policy if exists "anon_update_ride_drivers" on public.ride_drivers;
create policy "anon_update_ride_drivers"
  on public.ride_drivers for update to anon, authenticated using (true) with check (true);

-- ----- 4c. ride_messages — per-trip chat between rider and driver ---
-- WebRTC signaling (offer/answer/ICE) is sent over realtime.broadcast
-- and never persisted; only chat text lives here so both sides can scroll
-- back if they reconnect mid-trip.
create table if not exists public.ride_messages (
  id          bigserial primary key,
  ride_id     uuid not null references public.ride_requests(id) on delete cascade,
  from_role   text not null check (from_role in ('rider','driver')),
  from_name   text,
  body        text not null check (length(body) between 1 and 2000),
  created_at  timestamptz not null default now()
);
create index if not exists ride_messages_ride_idx
  on public.ride_messages (ride_id, created_at);

alter table public.ride_messages enable row level security;

drop policy if exists "anon_read_ride_messages"   on public.ride_messages;
create policy "anon_read_ride_messages"
  on public.ride_messages for select to anon, authenticated using (true);

drop policy if exists "anon_insert_ride_messages" on public.ride_messages;
create policy "anon_insert_ride_messages"
  on public.ride_messages for insert to anon, authenticated with check (true);

-- ----- 5. Realtime publication ---------------------------------------
do $$ begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'drivers_online'
  ) then
    alter publication supabase_realtime add table public.drivers_online;
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'ride_requests'
  ) then
    alter publication supabase_realtime add table public.ride_requests;
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'ride_drivers'
  ) then
    alter publication supabase_realtime add table public.ride_drivers;
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'ride_messages'
  ) then
    alter publication supabase_realtime add table public.ride_messages;
  end if;
end $$;

-- ----- 6. Storage bucket for live-capture photos ---------------------
-- Create the bucket once in Supabase Storage:
--   Name:   ride-driver-photos
--   Public: YES   (public read so the app can show profiles without signed URLs)
-- Photos uploaded by the registration flow are written here under
--   <driver_id>/selfie.jpg, <driver_id>/vehicle.jpg, <driver_id>/plate.jpg,
--   <driver_id>/license.jpg
-- The SQL below makes the bucket publicly readable and lets anon insert
-- (matching the open-write posture of the rest of the demo).
do $$ begin
  if not exists (select 1 from storage.buckets where id = 'ride-driver-photos') then
    insert into storage.buckets (id, name, public) values ('ride-driver-photos', 'ride-driver-photos', true);
  end if;
end $$;

drop policy if exists "ride driver photos public read" on storage.objects;
create policy "ride driver photos public read"
  on storage.objects for select
  using (bucket_id = 'ride-driver-photos');

drop policy if exists "ride driver photos anon write" on storage.objects;
create policy "ride driver photos anon write"
  on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'ride-driver-photos');

drop policy if exists "ride driver photos anon update" on storage.objects;
create policy "ride driver photos anon update"
  on storage.objects for update to anon, authenticated
  using (bucket_id = 'ride-driver-photos') with check (bucket_id = 'ride-driver-photos');
