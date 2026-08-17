-- ============================================================================
-- house_demand_create()  —  anon-safe demand-pin creation RPC
-- ----------------------------------------------------------------------------
-- WHY: the `hdp insert` RLS policy is
--        (app_uid() IS NULL AND user_id IS NULL) OR (user_id = app_uid())
--   which is correct for the legacy JWT anon key, but under the new
--   `sb_publishable_…` API key an anonymous PostgREST insert is rejected
--   (42501) even though app_uid() resolves to null. That left the public
--   "Tell us what you want" flow (houses-compact.html, request-place.js)
--   unable to raise demand for signed-out seekers.
--
-- FIX: a SECURITY DEFINER function that performs the insert as the table
--   owner (bypassing the WITH CHECK) while still stamping ownership from
--   app_uid() — so a signed-in user owns their pin and an anonymous seeker
--   gets a user_id = NULL row they can later remove via house_demand_remove
--   (id + phone). Same trust model as the existing house_demand_remove RPC.
--
-- Idempotent: safe to re-run.
-- ============================================================================

-- Clean up the throwaway diagnostic helper if it is still around.
drop function if exists public._diag_ctx();

create or replace function public.house_demand_create(
  p_id             text,
  p_lat            double precision,
  p_lng            double precision,
  p_phone          text,
  p_region         text   default null,
  p_area           text   default null,
  p_district       text   default null,
  p_radius_m       integer default 3000,
  p_listing        text   default 'rent',
  p_type           text   default null,
  p_min_bedrooms   integer default 0,
  p_max_budget_tzs bigint  default 0,
  p_name           text   default null,
  p_note           text   default null,
  p_needed_from    date    default null,
  p_needed_by      date    default null
)
returns text
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id      text := coalesce(nullif(btrim(p_id), ''), 'dp-' || replace(gen_random_uuid()::text, '-', ''));
  v_listing text := lower(coalesce(p_listing, 'rent'));
  v_digits  text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
begin
  -- Validate at the boundary (never trust the client).
  if p_lat is null or p_lng is null then
    raise exception 'lat/lng required' using errcode = '22023';
  end if;
  if char_length(v_digits) < 9 then
    raise exception 'a reachable phone is required' using errcode = '22023';
  end if;
  if v_listing not in ('rent', 'sale') then
    v_listing := 'rent';
  end if;

  insert into public.house_demand_pins (
    id, lat, lng, area, region, district, radius_m, listing, type,
    min_bedrooms, max_budget_tzs, phone, name, note,
    needed_from, needed_by, user_id, active
  ) values (
    v_id, p_lat, p_lng, nullif(btrim(p_area), ''), nullif(btrim(p_region), ''),
    nullif(btrim(p_district), ''), greatest(coalesce(p_radius_m, 3000), 100),
    v_listing, nullif(btrim(p_type), ''),
    greatest(coalesce(p_min_bedrooms, 0), 0), greatest(coalesce(p_max_budget_tzs, 0), 0),
    p_phone, nullif(btrim(p_name), ''), nullif(btrim(p_note), ''),
    p_needed_from, p_needed_by,
    app_uid(),           -- signed-in => owns it; anonymous => NULL
    true
  )
  on conflict (id) do nothing;

  return v_id;
end;
$$;

grant execute on function public.house_demand_create(
  text, double precision, double precision, text, text, text, text,
  integer, text, text, integer, bigint, text, text, date, date
) to anon, authenticated;

notify pgrst, 'reload schema';
