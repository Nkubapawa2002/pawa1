-- Pawa Houses — public.houses table + house-photos storage bucket.
-- Idempotent. Safe to re-run.

create table if not exists public.houses (
  id                text primary key,
  title             text not null,
  type              text not null check (type in ('apartment','house','plot','office')),
  listing           text not null check (listing in ('rent','sale')),
  price_tzs         bigint not null default 0 check (price_tzs >= 0),
  currency          text not null default 'TZS',
  period            text default 'month',
  bedrooms          int  not null default 0,
  bathrooms         int  not null default 0,
  size_sqm          int,
  min_months        int  not null default 1,  -- min months a renter pays upfront (rent only)
  region            text,
  area              text,
  address           text,
  lat               double precision,
  lng               double precision,
  amenities         text[] not null default '{}',
  furnished         text default 'no' check (furnished in ('yes','no','semi','n/a')),
  photo             text,
  photos            text[] not null default '{}'::text[],
  videos            text[] not null default '{}'::text[],
  extra_costs       jsonb not null default '[]'::jsonb,  -- [{label,amount,billing}] bills shown to clients
  description       text,
  verified          boolean not null default false,
  available_from    date,
  agent             jsonb not null default '{}'::jsonb,
  owner_user_id     uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Idempotent column adds for older databases that pre-date these fields.
alter table public.houses add column if not exists photos text[] not null default '{}'::text[];
alter table public.houses add column if not exists videos text[] not null default '{}'::text[];
alter table public.houses add column if not exists extra_costs jsonb not null default '[]'::jsonb;
alter table public.houses add column if not exists min_months int not null default 1;
alter table public.houses add column if not exists owner_user_id uuid references auth.users(id) on delete set null;

create index if not exists houses_region_idx     on public.houses (region);
create index if not exists houses_area_idx       on public.houses (area);
create index if not exists houses_type_idx       on public.houses (type);
create index if not exists houses_listing_idx    on public.houses (listing);
create index if not exists houses_price_idx      on public.houses (price_tzs);
create index if not exists houses_lat_lng_idx    on public.houses (lat, lng);

alter table public.houses enable row level security;

drop policy if exists "houses readable"     on public.houses;
drop policy if exists "houses owner insert" on public.houses;
drop policy if exists "houses owner update" on public.houses;
drop policy if exists "houses owner delete" on public.houses;

create policy "houses readable" on public.houses for select using (true);
create policy "houses owner insert" on public.houses for insert
  with check (auth.uid() is not null and owner_user_id = auth.uid());
create policy "houses owner update" on public.houses for update
  using (owner_user_id = auth.uid()) with check (owner_user_id = auth.uid());
create policy "houses owner delete" on public.houses for delete
  using (owner_user_id = auth.uid());

-- house-photos storage bucket (public, 60 MB, photos + short video clips)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'house-photos', 'house-photos', true, 62914560,
  array['image/jpeg','image/png','image/webp',
        'video/mp4','video/webm','video/quicktime']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "house-photos readable" on storage.objects;
create policy "house-photos readable" on storage.objects for select
  using (bucket_id = 'house-photos');

drop policy if exists "house-photos upload" on storage.objects;
create policy "house-photos upload" on storage.objects for insert
  with check (bucket_id = 'house-photos' and auth.uid() is not null);
