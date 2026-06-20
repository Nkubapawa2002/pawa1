-- ============================================================================
-- house_demand_for_agent.sql — route a seeker's request to the RIGHT agents
-- ============================================================================
-- THE MATCHING ALGORITHM (kept in Postgres — the source of truth — so it can't
-- crash an app tier and scales to millions of rows on indexed lookups):
--
--   A seeker types what they want (any kind of place), a price, where + when.
--   We tag the request with its REGION and DISTRICT (reverse-geocoded). Every
--   agent declares a region + district of operation (agent_profiles). The match
--   is then a directed lookup, ranked:
--
--     1. region MUST equal the agent's region        (the hard guarantee)
--     2. district == agent's district  → shown FIRST  (precise routing)
--        else same-region requests       → shown after (still relevant)
--     3. only ACTIVE requests whose deadline hasn't passed
--     4. optional listing (rent/sale) filter the agent can serve
--     5. most-urgent deadline first, then newest
--
-- So a request is shown to SPECIFIC agents (those who work that region/district),
-- never broadcast randomly. This file:
--   • lets a request carry ANY type (drops the old type CHECK constraint),
--   • adds a `district` column + index to house_demand_pins,
--   • creates house_demand_for_agent(region, district, listing, limit).
--
-- Idempotent. Safe to re-run. Depends on setup_house_demand.sql +
-- house_demand_needed_by.sql + house_demand_region.sql. Paste & Run.
-- ============================================================================
begin;

-- 1. A seeker may want ANY kind of place (self-contained, frame, godown,
--    hostel…), so the type is now free text — drop the old whitelist CHECK.
alter table public.house_demand_pins
  drop constraint if exists house_demand_pins_type_check;

-- 2. District — the precise routing key (region already exists).
alter table public.house_demand_pins
  add column if not exists district text;

-- Two purpose-built PARTIAL indexes (only the rows we ever match — the active
-- ones), so each side of the match walks an index in result order and STOPS at
-- the limit instead of scanning + sorting the whole region. This is what keeps
-- it fast at millions of rows (proven by scripts/bench_demand_match.mjs).
--   • by region + district + urgency  → the precise (district) slice
--   • by region + urgency             → the region-wide slice
-- "No deadline" sorts as +infinity (after every real deadline) so the urgency
-- filter + ordering collapse into ONE index range scan — no post-scan sort.
create index if not exists hdp_match_district_idx
  on public.house_demand_pins (lower(region), lower(district), (coalesce(needed_by, 'infinity'::date)), created_at desc)
  where active;
create index if not exists hdp_match_region_idx
  on public.house_demand_pins (lower(region), (coalesce(needed_by, 'infinity'::date)), created_at desc)
  where active;

-- 3. The match: my district's requests first, then the rest of my region.
--    Each slice is fetched index-ordered + limited (cheap), then the two small
--    slices are merged — never a full-region sort.
create or replace function public.house_demand_for_agent(
  p_region   text,
  p_district text default null,
  p_listing  text default null,   -- null = both rent & sale
  p_limit    int  default 200
) returns table (
  id            text,
  area          text,
  region        text,
  district      text,
  phone         text,
  name          text,
  note          text,
  type          text,
  min_bedrooms  int,
  max_budget_tzs bigint,
  needed_from   date,
  needed_by     date,
  lat           double precision,
  lng           double precision,
  listing       text,
  match_level   text,             -- 'district' (precise) | 'region'
  created_at    timestamptz
)
language sql stable security definer
set search_path = public as $$
  with lim as (select greatest(1, least(p_limit, 1000)) n),
  district_slice as (
    select d.*, 0 as ord, 'district'::text as ml
    from public.house_demand_pins d, lim
    where d.active
      and p_district is not null and d.district is not null
      and lower(d.region) = lower(p_region)
      and lower(d.district) = lower(p_district)
      and (p_listing is null or d.listing = p_listing)
      and coalesce(d.needed_by, 'infinity'::date) >= current_date
    order by coalesce(d.needed_by, 'infinity'::date) asc, d.created_at desc
    limit (select n from lim)
  ),
  region_slice as (
    select d.*, 1 as ord, 'region'::text as ml
    from public.house_demand_pins d, lim
    where d.active
      and lower(d.region) = lower(p_region)
      and (p_district is null or d.district is null or lower(d.district) <> lower(p_district))
      and (p_listing is null or d.listing = p_listing)
      and coalesce(d.needed_by, 'infinity'::date) >= current_date
    order by coalesce(d.needed_by, 'infinity'::date) asc, d.created_at desc
    limit (select n from lim)
  ),
  merged as (select * from district_slice union all select * from region_slice)
  select
    id, area, region, district, phone, name, note, type,
    min_bedrooms, max_budget_tzs, needed_from, needed_by,
    lat, lng, listing, ml as match_level, created_at
  from merged
  order by ord, coalesce(needed_by, 'infinity'::date) asc, created_at desc
  limit (select n from lim);
$$;

grant execute on function public.house_demand_for_agent(text, text, text, int)
  to authenticated;

commit;

-- ============================================================================
-- Done. As a signed-in agent:
--   select id, match_level, district, needed_by
--   from house_demand_for_agent('Dar es Salaam', 'Kinondoni');
--   → Kinondoni requests first (match_level='district'), then the rest of
--     the Dar es Salaam region, most-urgent first.
-- ============================================================================
