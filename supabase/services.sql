-- ============================================================================
-- Pawa Daily Services — public.services table + service-photos storage bucket.
--
-- A marketplace of human daily-service providers (cleaning, plumbing,
-- electrical, carpentry, tutoring, beauty, childcare, etc.). A provider
-- registers their service with photos at their base location; customers browse,
-- filter by category, and find the provider nearest them.
--
-- Mirrors public.trucks (supabase/trucks.sql): public read, owner writes
-- (owner_user_id = auth.uid()), admin override. Listings are also gated by the
-- agent pay-or-pause subscription system — a suspended/deactivated provider is
-- hidden from clients (see supabase/agent_subscription.sql + agent_grace_active.sql).
--
-- Depends on: schema_master.sql (regions, touch_updated_at, is_admin) and
-- agent_subscription.sql (uid_suspended). Idempotent — safe to re-run.
-- ============================================================================
create table if not exists public.services (
  id                text primary key,
  title             text not null,
  category          text not null default 'other'
                      check (category in (
                        'cleaning','plumbing','electrical','carpentry','painting',
                        'gardening','moving_help','laundry','cooking','tutoring',
                        'beauty','security','childcare','appliance_repair','other')),
  price_tzs         bigint not null default 0 check (price_tzs >= 0),  -- "from" price
  currency          text not null default 'TZS',
  rate_type         text not null default 'per_job'
                      check (rate_type in ('hourly','daily','per_job','monthly')),
  negotiable        boolean not null default true,
  experience_years  int check (experience_years is null or experience_years >= 0),
  availability      text,                              -- free text e.g. "Mon–Sat, 8am–6pm"
  service_area      text not null default 'within_city'
                      check (service_area in ('within_city','region_wide','cross_region')),
  region            text references public.regions(name) on update cascade,
  area              text,                              -- ward / neighbourhood the provider is based in
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

create index if not exists services_region_idx   on public.services (region);
create index if not exists services_area_idx      on public.services (area);
create index if not exists services_category_idx  on public.services (category);
create index if not exists services_rate_idx      on public.services (rate_type);
create index if not exists services_price_idx     on public.services (price_tzs);
create index if not exists services_lat_lng_idx   on public.services (lat, lng);
create index if not exists services_owner_idx     on public.services (owner_user_id);

drop trigger if exists set_services_updated_at on public.services;
create trigger set_services_updated_at
  before update on public.services
  for each row execute function public.touch_updated_at();

alter table public.services enable row level security;
drop policy if exists "services readable"     on public.services;
drop policy if exists "services owner insert" on public.services;
drop policy if exists "services owner update" on public.services;
drop policy if exists "services owner delete" on public.services;
drop policy if exists "services admin write"  on public.services;

-- Public browse — but a suspended/deactivated provider's listings are hidden
-- (owner still sees their own so they can renew; admins see everything).
create policy "services readable" on public.services for select using (
  not public.uid_suspended(owner_user_id)
  or owner_user_id = auth.uid()
  or public.is_admin()
);

-- Owners can insert their own services (must set owner_user_id = their uid).
create policy "services owner insert" on public.services for insert
  with check (auth.uid() is not null and owner_user_id = auth.uid());

-- Owners can edit / delete only their own services.
create policy "services owner update" on public.services for update
  using (owner_user_id = auth.uid()) with check (owner_user_id = auth.uid());
create policy "services owner delete" on public.services for delete
  using (owner_user_id = auth.uid());

-- Admins can do anything.
create policy "services admin write" on public.services for all
  using (public.is_admin()) with check (public.is_admin());

-- ----------------------------------------------------------------------------
-- service-photos storage bucket (public-read, 20 MB max, jpg/png/webp)
-- ----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'service-photos', 'service-photos', true, 20971520,
  array['image/jpeg','image/png','image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "service-photos readable" on storage.objects;
create policy "service-photos readable" on storage.objects for select
  using (bucket_id = 'service-photos');

drop policy if exists "service-photos upload" on storage.objects;
create policy "service-photos upload" on storage.objects for insert
  with check (bucket_id = 'service-photos' and auth.uid() is not null);

drop policy if exists "service-photos admin write" on storage.objects;
create policy "service-photos admin write" on storage.objects for all
  using (bucket_id = 'service-photos' and public.is_admin())
  with check (bucket_id = 'service-photos' and public.is_admin());
