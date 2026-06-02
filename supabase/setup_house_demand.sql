-- Pawa Houses — DEMAND PINS.
--
-- The flip side of a listing: a *renter/buyer* drops a pin on the area they
-- want to live in, with their budget + specs + phone, when no property there
-- matches yet. Later, when an agent posts a property in that area, the agent
-- is shown how many people are waiting nearby and their phone numbers — so a
-- new listing finds its tenants instantly.
--
-- Idempotent. Safe to re-run. Paste into the Supabase SQL editor and Run.

-- ---------------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------------
create table if not exists public.house_demand_pins (
  id              text primary key,
  lat             double precision not null,
  lng             double precision not null,
  area            text,                       -- human label of the pinned spot
  region          text,
  radius_m        int  not null default 1500, -- how wide the renter will accept
  listing         text not null default 'rent' check (listing in ('rent','sale')),
  type            text check (type in ('apartment','house','plot','office')),
  min_bedrooms    int  not null default 0,
  max_budget_tzs  bigint not null default 0 check (max_budget_tzs >= 0), -- 0 = no cap
  phone           text not null,              -- how the agent reaches them
  name            text,
  note            text,
  user_id         uuid references auth.users(id) on delete set null,
  active          boolean not null default true,
  notified_count  int not null default 0,     -- how many matching listings we've surfaced
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists hdp_lat_lng_idx  on public.house_demand_pins (lat, lng);
create index if not exists hdp_active_idx    on public.house_demand_pins (active);
create index if not exists hdp_listing_idx   on public.house_demand_pins (listing);
create index if not exists hdp_user_idx      on public.house_demand_pins (user_id);

-- ---------------------------------------------------------------------------
-- 2. RLS — a pin is PRIVATE. The phone number must never be browsable.
--    * anyone (even anon) may INSERT a pin (renters needn't have an account);
--      if signed in, the row is tied to their uid.
--    * a user may SELECT / UPDATE / DELETE only their OWN pins.
--    * NO blanket select — agents read waiting renters only through the
--      security-definer RPC below, which only ever returns pins near a point.
-- ---------------------------------------------------------------------------
alter table public.house_demand_pins enable row level security;

drop policy if exists "hdp insert"      on public.house_demand_pins;
drop policy if exists "hdp owner read"  on public.house_demand_pins;
drop policy if exists "hdp owner update" on public.house_demand_pins;
drop policy if exists "hdp owner delete" on public.house_demand_pins;

create policy "hdp insert" on public.house_demand_pins for insert
  with check (
    -- anonymous pin: no user_id; signed-in pin: must be your own uid.
    (auth.uid() is null and user_id is null)
    or user_id = auth.uid()
  );
create policy "hdp owner read" on public.house_demand_pins for select
  using (user_id is not null and user_id = auth.uid());
create policy "hdp owner update" on public.house_demand_pins for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "hdp owner delete" on public.house_demand_pins for delete
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 3. Haversine (km) — pure SQL, matches js/houses.js + services/go/geo.go.
-- ---------------------------------------------------------------------------
create or replace function public.hdp_haversine_km(
  lat1 double precision, lng1 double precision,
  lat2 double precision, lng2 double precision
) returns double precision
language sql immutable parallel safe as $$
  select 2 * 6371 * asin(sqrt(
    sin(radians(lat2 - lat1) / 2) ^ 2 +
    cos(radians(lat1)) * cos(radians(lat2)) *
    sin(radians(lng2 - lng1) / 2) ^ 2
  ));
$$;

-- ---------------------------------------------------------------------------
-- 4. The agent's view: who is waiting near a point I'm about to list in?
--
--    SECURITY DEFINER so it can read across users (to surface phones) WITHOUT
--    opening the table to blanket reads — it only ever returns active pins
--    whose acceptance circle overlaps the agent's listing point, optionally
--    constrained to a listing kind / type / price the agent can actually offer.
--
--    A pin matches when:
--      distance(pin, listing) <= max(pin.radius_m, p_radius_m)
--      and pin.listing  = p_listing            (rent-seekers vs buyers)
--      and (pin.type is null or p_type is null or pin.type = p_type)
--      and (pin.max_budget_tzs = 0 or p_price = 0 or p_price <= pin.max_budget)
--      and (pin.min_bedrooms = 0 or p_bedrooms >= pin.min_bedrooms)
-- ---------------------------------------------------------------------------
create or replace function public.house_demand_near(
  p_lat       double precision,
  p_lng       double precision,
  p_radius_m  int     default 1500,
  p_listing   text    default 'rent',
  p_type      text    default null,
  p_price     bigint  default 0,
  p_bedrooms  int     default 0
) returns table (
  id            text,
  area          text,
  phone         text,
  name          text,
  note          text,
  min_bedrooms  int,
  max_budget_tzs bigint,
  distance_m    int,
  created_at    timestamptz
)
language sql stable security definer
set search_path = public as $$
  select
    d.id, d.area, d.phone, d.name, d.note,
    d.min_bedrooms, d.max_budget_tzs,
    round(public.hdp_haversine_km(d.lat, d.lng, p_lat, p_lng) * 1000)::int as distance_m,
    d.created_at
  from public.house_demand_pins d
  where d.active
    and d.listing = p_listing
    and (d.type is null or p_type is null or d.type = p_type)
    and (d.max_budget_tzs = 0 or p_price = 0 or p_price <= d.max_budget_tzs)
    and (d.min_bedrooms = 0 or p_bedrooms = 0 or p_bedrooms >= d.min_bedrooms)
    and public.hdp_haversine_km(d.lat, d.lng, p_lat, p_lng) * 1000
        <= greatest(d.radius_m, p_radius_m)
  order by distance_m asc;
$$;

-- Let signed-in agents (and the anon browse role, for the demo) call it.
grant execute on function public.house_demand_near(
  double precision, double precision, int, text, text, bigint, int
) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Count-only helper for the public heatmap ("3 people waiting here") that
--    never leaks a phone number — safe to call from the renter browse page.
-- ---------------------------------------------------------------------------
create or replace function public.house_demand_count_near(
  p_lat double precision, p_lng double precision, p_radius_m int default 1500
) returns int
language sql stable security definer
set search_path = public as $$
  select count(*)::int
  from public.house_demand_pins d
  where d.active
    and public.hdp_haversine_km(d.lat, d.lng, p_lat, p_lng) * 1000
        <= greatest(d.radius_m, p_radius_m);
$$;

grant execute on function public.house_demand_count_near(
  double precision, double precision, int
) to anon, authenticated;
