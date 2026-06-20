-- ============================================================================
-- house_demand_region.sql — route demand/alerts to agents BY REGION
-- ============================================================================
-- A seeker can now just TYPE what they want — where, the price, and when — with
-- no map. That request is saved as a demand pin tagged with its `region`, and
-- every agent who operates in that region sees it on their dashboard (not only
-- the ones who happen to list within a few km of the exact spot).
--
-- This adds:
--   1. a region index on house_demand_pins (the column already exists);
--   2. house_demand_in_region() — a SECURITY DEFINER lookup that returns the
--      active, not-yet-expired demand in a region WITH the seeker's phone, so a
--      signed-in agent can call them. Granted to `authenticated` only (an agent
--      is always signed in) — region-wide phone lists are NOT exposed to anon.
--
-- Idempotent. Safe to re-run. Depends on supabase/setup_house_demand.sql and
-- supabase/house_demand_needed_by.sql. Paste into the Supabase SQL editor, Run.
-- ============================================================================
begin;

-- 1. Make sure the region column + a case-insensitive index exist.
alter table public.house_demand_pins
  add column if not exists region text;

create index if not exists hdp_region_idx
  on public.house_demand_pins (lower(region));

-- 2. The agent's region view: everyone currently waiting in MY region.
create or replace function public.house_demand_in_region(
  p_region   text,
  p_listing  text default null,   -- null = both rent & sale
  p_limit    int  default 200
) returns table (
  id            text,
  area          text,
  region        text,
  phone         text,
  name          text,
  note          text,
  min_bedrooms  int,
  max_budget_tzs bigint,
  needed_from   date,
  needed_by     date,
  lat           double precision,
  lng           double precision,
  listing       text,
  type          text,
  created_at    timestamptz
)
language sql stable security definer
set search_path = public as $$
  select
    d.id, d.area, d.region, d.phone, d.name, d.note,
    d.min_bedrooms, d.max_budget_tzs, d.needed_from, d.needed_by,
    d.lat, d.lng, d.listing, d.type, d.created_at
  from public.house_demand_pins d
  where d.active
    and p_region is not null
    and d.region is not null
    and lower(trim(d.region)) = lower(trim(p_region))
    and (p_listing is null or d.listing = p_listing)
    and (d.needed_by is null or d.needed_by >= current_date)   -- deadline not passed
  order by d.needed_by asc nulls last, d.created_at desc
  limit greatest(1, least(p_limit, 1000));
$$;

-- Signed-in agents only — a whole region's phone numbers should never be
-- readable by the anonymous browse role.
grant execute on function public.house_demand_in_region(text, text, int)
  to authenticated;

commit;

-- ============================================================================
-- Done. Verify:
--   • house_demand_pins has a `region` column + hdp_region_idx;
--   • select * from house_demand_in_region('Dar es Salaam');  -- as an agent
--     returns the active, non-expired requests in that region with phones.
-- ============================================================================
