-- ============================================================================
-- house_demand_needed_by.sql — give demand pins a "needed by" deadline
-- ============================================================================
-- A renter/buyer who pins demand can now say WHEN they need the place by. This
-- turns the waiting list into an urgency signal for agents: they see who has the
-- soonest move-in date and can close the deal BEFORE that deadline (and before a
-- competitor) — which is also when an agent whose tenant is about to vacate can
-- line up the next renter ahead of the rent-expiry date.
--
-- Idempotent. Safe to re-run. Depends on supabase/setup_house_demand.sql.
-- Paste into the Supabase SQL editor and Run.
-- ============================================================================
begin;

-- 1. The deadline + start columns. needed_from = earliest the seeker wants to
--    move in; needed_by = the deadline. Both NULL = "no rush / open-ended".
alter table public.house_demand_pins
  add column if not exists needed_by date;
alter table public.house_demand_pins
  add column if not exists needed_from date;

create index if not exists hdp_needed_by_idx on public.house_demand_pins (needed_by);

-- 2. Recreate the agent lookup so it (a) returns needed_by, (b) hides demand
--    whose deadline already passed (they're no longer waiting), and (c) orders
--    by URGENCY — soonest deadline first, then nearest. Drop first because the
--    returned column list changes.
drop function if exists public.house_demand_near(
  double precision, double precision, int, text, text, bigint, int);

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
  needed_from   date,
  needed_by     date,
  distance_m    int,
  created_at    timestamptz
)
language sql stable security definer
set search_path = public as $$
  select
    d.id, d.area, d.phone, d.name, d.note,
    d.min_bedrooms, d.max_budget_tzs, d.needed_from, d.needed_by,
    round(public.hdp_haversine_km(d.lat, d.lng, p_lat, p_lng) * 1000)::int as distance_m,
    d.created_at
  from public.house_demand_pins d
  where d.active
    and d.listing = p_listing
    and (d.type is null or p_type is null or d.type = p_type)
    and (d.max_budget_tzs = 0 or p_price = 0 or p_price <= d.max_budget_tzs)
    and (d.min_bedrooms = 0 or p_bedrooms = 0 or p_bedrooms >= d.min_bedrooms)
    and (d.needed_by is null or d.needed_by >= current_date)   -- deadline not yet passed
    and public.hdp_haversine_km(d.lat, d.lng, p_lat, p_lng) * 1000
        <= greatest(d.radius_m, p_radius_m)
  order by d.needed_by asc nulls last, distance_m asc;          -- most urgent first
$$;

grant execute on function public.house_demand_near(
  double precision, double precision, int, text, text, bigint, int
) to anon, authenticated;

commit;

-- ============================================================================
-- Done. Verify:
--   • house_demand_pins now has a `needed_by` column;
--   • house_demand_near returns needed_by and lists the most urgent waiting
--     renters first (deadlines that have passed are excluded).
-- ============================================================================
