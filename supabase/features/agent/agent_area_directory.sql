-- ============================================================================
--  agent_area_directory.sql — the agent list shows every ward, not one.
-- ============================================================================
--  agent_multi_area.sql made an agent's wards a set and taught
--  house_demand_near to match against all of them. pm_agent_card was updated
--  with it. The two DIRECTORY functions were not, so the list you browse
--  agents in still showed a single ward: an agent covering Mikocheni, Msasani
--  and Kijitonyama read as covering Mikocheni, and the one you were looking
--  for looked like the wrong agent.
--
--  Both functions gain `wards text[]` and `districts text[]` beside the
--  singular columns, which stay: they are the primary, and the search filter
--  below still matches on them.
--
--  WHY THIS FILE IS GENERATED, AND WHY IT DROPS INSIDE A TRANSACTION
--  Both bodies are long, and pm_agent_finder's is a UNION whose two branches
--  must keep the same column count. Adding a column to one arm and not the
--  other is rejected. This file was generated from the repo's own newest
--  definitions (p_message_call.sql and p_message_guests.sql) so the copy
--  cannot drift from them.
--
--  A RETURNS TABLE cannot be changed by CREATE OR REPLACE, so each function
--  has to be dropped first. That is done INSIDE the transaction: a create that
--  fails then rolls the drop back, instead of leaving production without a
--  function the app calls on every open of the agent list. Doing this outside
--  a transaction is exactly how that outage happens.
--
--  Depends on agent_multi_area.sql (agent_profiles.wards/districts).
-- ============================================================================

begin;

drop function if exists public.pm_agent_finder(text, text, text, integer);

create or replace function public.pm_agent_finder(
  p_region   text default null,
  p_query    text default null,
  p_category text default null,
  p_limit    int  default 300
) returns table (
  user_id        text,
  display_name   text,
  region         text,
  area           text,
  area_kind      text,
  district       text,
  ward           text,
  wards          text[],
  districts      text[],
  lat            double precision,
  lng            double precision,
  is_agent       boolean,
  reachable      boolean,
  public_key     text,
  fingerprint    text,
  n_houses       int,
  n_services     int,
  n_trucks       int,
  n_jobs         int,
  n_verified     int,
  last_listed_at timestamptz,
  last_seen_at   timestamptz,
  kinds          text[],
  phone          text
)
  language sql
  stable
  security definer
  set search_path = public
as $fn$
  with people as (
    select
      ap.user_id,
      coalesce(k.display_name, ap.name)   as display_name,
      coalesce(k.region, ap.region)       as region,
      ap.area_of_operations               as area,
      ap.area_kind, ap.district, ap.ward,
      coalesce(ap.wards, '{}') as wards,
      coalesce(ap.districts, '{}') as districts,
      ap.lat, ap.lng,
      true                                as is_agent,
      (k.public_key is not null)          as reachable,
      k.public_key, k.fingerprint
    from public.agent_profiles ap
    left join public.pm_keys k on k.user_id = ap.user_id
    union
    select
      k.user_id, k.display_name, k.region,
      null::text, null::text, null::text, null::text,
      '{}'::text[], '{}'::text[],
      null::double precision, null::double precision,
      k.is_agent, true, k.public_key, k.fingerprint
    from public.pm_keys k
    where not exists (select 1 from public.agent_profiles ap2 where ap2.user_id = k.user_id)
      and not coalesce(k.is_guest, false)
  ),
  counted as (
    select
      p.*,
      (select count(*)::int from public.pm_owner_listings o
        where o.user_id = p.user_id and o.cat = 'houses')          as n_houses,
      (select count(*)::int from public.pm_owner_listings o
        where o.user_id = p.user_id and o.cat = 'services')        as n_services,
      (select count(*)::int from public.pm_owner_listings o
        where o.user_id = p.user_id and o.cat = 'trucks')          as n_trucks,
      (select count(*)::int from public.pm_owner_listings o
        where o.user_id = p.user_id and o.cat = 'jobs')            as n_jobs,
      (select count(*)::int from public.pm_owner_listings o
        where o.user_id = p.user_id and o.verified)                as n_verified,
      (select max(o.updated_at) from public.pm_owner_listings o
        where o.user_id = p.user_id)                               as last_listed_at,
      (select date_trunc('minute', pr.last_seen_at) from public.pm_presence pr
        where pr.user_id = p.user_id)                              as last_seen_at,
      (select array_agg(t.kind order by t.n desc, t.kind)
         from (
           select o.kind, count(*) as n
             from public.pm_owner_listings o
            where o.user_id = p.user_id
              and o.kind is not null and btrim(o.kind) <> ''
              and (p_category is null or p_category = '' or o.cat = p_category)
            group by o.kind
            order by count(*) desc, o.kind
            limit 4
         ) t)                                                      as kinds,
      -- The number off the listing they touched last. The jobs arm is fenced
      -- to people who already hold a P-Message key: see the header. Nulls sort
      -- last, so a listing with no number never beats one that has one.
      (select o.phone from public.pm_owner_listings o
        where o.user_id = p.user_id
          and o.phone is not null
          and (o.cat <> 'jobs' or p.reachable)
        order by o.updated_at desc nulls last
        limit 1)                                                   as phone
    from people p
  )
  select
    user_id, display_name, region, area, area_kind, district, ward,
    wards, districts, lat, lng,
    is_agent, reachable, public_key, fingerprint,
    n_houses, n_services, n_trucks, n_jobs, n_verified, last_listed_at,
    last_seen_at, kinds, phone
  from counted
  where (p_region is null or p_region = '' or region = p_region)
    and (
      p_query is null or p_query = '' or
      display_name ilike '%' || p_query || '%' or
      area         ilike '%' || p_query || '%' or
      district     ilike '%' || p_query || '%' or
      ward         ilike '%' || p_query || '%' or
      exists (
        select 1 from public.pm_owner_listings o
        where o.user_id = counted.user_id
          and (p_category is null or p_category = '' or o.cat = p_category)
          and (o.kind ilike '%' || p_query || '%' or o.title ilike '%' || p_query || '%')
      )
    )
    and (
      p_category is null or p_category = '' or
      case p_category
        when 'houses'   then n_houses   > 0
        when 'services' then n_services > 0
        when 'trucks'   then n_trucks   > 0
        when 'jobs'     then n_jobs     > 0
        else false
      end
    )
    and coalesce(public.app_uid(), '') <> ''
    and user_id <> coalesce(public.app_uid(), '')
  order by reachable desc, is_agent desc, display_name nulls last
  limit greatest(1, least(coalesce(p_limit, 300), 500));
$fn$;

drop function if exists public.pm_directory(text, text, integer);

create or replace function public.pm_directory(
  p_region text default null,
  p_query  text default null,
  p_limit  int  default 200
) returns table (
  user_id      text,
  display_name text,
  region       text,
  area         text,
  area_kind    text,
  district     text,
  ward         text,
  wards        text[],
  districts    text[],
  is_agent     boolean,
  reachable    boolean,
  public_key   text,
  fingerprint  text
)
  language sql
  stable
  security definer
  set search_path = public
as $$
  with people as (
    select
      ap.user_id,
      coalesce(k.display_name, ap.name)              as display_name,
      coalesce(k.region, ap.region)                  as region,
      ap.area_of_operations                          as area,
      ap.area_kind, ap.district, ap.ward, coalesce(ap.wards, '{}') as wards, coalesce(ap.districts, '{}') as districts,
      true                                           as is_agent,
      (k.public_key is not null)                     as reachable,
      k.public_key, k.fingerprint
    from public.agent_profiles ap
    left join public.pm_keys k on k.user_id = ap.user_id
    union
    select
      k.user_id, k.display_name, k.region,
      null::text, null::text, null::text, null::text,
      '{}'::text[], '{}'::text[],
      k.is_agent, true, k.public_key, k.fingerprint
    from public.pm_keys k
    where not exists (select 1 from public.agent_profiles ap2 where ap2.user_id = k.user_id)
      and not k.is_guest
  )
  select * from people
  where (p_region is null or p_region = '' or region = p_region)
    and (
      p_query is null or p_query = '' or
      display_name ilike '%' || p_query || '%' or
      area         ilike '%' || p_query || '%' or
      district     ilike '%' || p_query || '%' or
      ward         ilike '%' || p_query || '%'
    )
    -- Signed-in callers only, guests included: a guest is signed in, just not
    -- identified. What stays shut out is the public anon key on its own.
    and coalesce(public.app_uid(), '') <> ''
    and user_id <> coalesce(public.app_uid(), '')
  order by reachable desc, is_agent desc, display_name nulls last
  limit greatest(1, least(coalesce(p_limit, 200), 500));
$$;

grant execute on function public.pm_agent_finder(text, text, text, integer) to anon, authenticated;
grant execute on function public.pm_directory(text, text, integer) to anon, authenticated;

commit;
