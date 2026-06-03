-- ============================================================================
-- Pawa Moving Trucks — public.trucks table + truck-photos storage bucket.
--
-- A directory of moving/hire trucks (the "transport my goods to the new home"
-- companion to the houses listings). An owner registers a truck at its BASE
-- location with photos; users browse and find the truck nearest them.
--
-- Mirrors public.houses (schema_master.sql section 34): public read, owner
-- writes (owner_user_id = auth.uid()), admin override. Idempotent — safe to
-- re-run. Run this in the Supabase SQL editor.
-- ============================================================================
create table if not exists public.trucks (
  id                text primary key,
  title             text not null,
  truck_type        text not null default 'canter'
                      check (truck_type in ('pickup','canter','3ton','7ton','10ton_plus','other')),
  capacity_tonnes   numeric check (capacity_tonnes is null or capacity_tonnes >= 0),
  price_tzs         bigint not null default 0 check (price_tzs >= 0),  -- "from" per-trip price
  currency          text not null default 'TZS',
  period            text not null default 'trip',                      -- per trip
  negotiable        boolean not null default true,
  driver_included   boolean not null default true,
  loaders_included  boolean not null default false,
  service_area      text not null default 'within_city'
                      check (service_area in ('within_city','region_wide','cross_region')),
  region            text references public.regions(name) on update cascade,
  area              text,                              -- ward / neighbourhood the truck is based in
  address           text,                              -- free-text base location
  lat               double precision,
  lng               double precision,
  photo             text,                              -- cover: storage path OR external URL
  photos            text[] not null default '{}'::text[],
  description       text,
  verified          boolean not null default false,
  owner             jsonb not null default '{}'::jsonb,  -- {name, phone, whatsapp}
  owner_user_id     uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists trucks_region_idx   on public.trucks (region);
create index if not exists trucks_area_idx      on public.trucks (area);
create index if not exists trucks_type_idx      on public.trucks (truck_type);
create index if not exists trucks_service_idx   on public.trucks (service_area);
create index if not exists trucks_price_idx     on public.trucks (price_tzs);
create index if not exists trucks_lat_lng_idx   on public.trucks (lat, lng);

drop trigger if exists set_trucks_updated_at on public.trucks;
create trigger set_trucks_updated_at
  before update on public.trucks
  for each row execute function public.touch_updated_at();

alter table public.trucks enable row level security;
drop policy if exists "trucks readable"     on public.trucks;
drop policy if exists "trucks owner insert" on public.trucks;
drop policy if exists "trucks owner update" on public.trucks;
drop policy if exists "trucks owner delete" on public.trucks;
drop policy if exists "trucks admin write"  on public.trucks;

-- Anyone (signed in or anonymous) can browse trucks.
create policy "trucks readable" on public.trucks for select using (true);

-- Owners can insert their own trucks (must set owner_user_id = their uid).
create policy "trucks owner insert" on public.trucks for insert
  with check (auth.uid() is not null and owner_user_id = auth.uid());

-- Owners can edit / delete only their own trucks.
create policy "trucks owner update" on public.trucks for update
  using (owner_user_id = auth.uid()) with check (owner_user_id = auth.uid());
create policy "trucks owner delete" on public.trucks for delete
  using (owner_user_id = auth.uid());

-- Admins can do anything.
create policy "trucks admin write" on public.trucks for all
  using (public.is_admin()) with check (public.is_admin());

-- ----------------------------------------------------------------------------
-- truck-photos storage bucket (public-read, 20 MB max, jpg/png/webp)
-- ----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'truck-photos', 'truck-photos', true, 20971520,
  array['image/jpeg','image/png','image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Anyone can read the photos (the bucket is public anyway, but be explicit).
drop policy if exists "truck-photos readable" on storage.objects;
create policy "truck-photos readable" on storage.objects for select
  using (bucket_id = 'truck-photos');

-- Signed-in users can upload to the bucket; admins can manage everything.
drop policy if exists "truck-photos upload" on storage.objects;
create policy "truck-photos upload" on storage.objects for insert
  with check (bucket_id = 'truck-photos' and auth.uid() is not null);

drop policy if exists "truck-photos admin write" on storage.objects;
create policy "truck-photos admin write" on storage.objects for all
  using (bucket_id = 'truck-photos' and public.is_admin())
  with check (bucket_id = 'truck-photos' and public.is_admin());
