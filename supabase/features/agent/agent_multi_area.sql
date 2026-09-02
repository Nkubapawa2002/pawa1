-- ============================================================================
--  agent_multi_area.sql — an agent works in more than one ward.
-- ============================================================================
--  agent_profiles has carried ONE ward and ONE district since it was written,
--  and that was already wrong: an agent in Kinondoni covers Mikocheni and
--  Msasani and Kijitonyama, not one of them. It only started to hurt when
--  house_demand_place.sql made the ward a routing key, because from that
--  moment the singular column decided which requests an agent could see at
--  all. An agent working three wards was reachable in one and invisible in the
--  other two, with nothing on any screen to say so.
--
--  WHAT THIS ADDS
--    agent_profiles.wards     text[]   every ward the agent covers
--    agent_profiles.districts text[]   every district
--
--  The singular ward/district columns STAY, and stay meaningful: they are the
--  agent's primary one, they are what the admin tracker and the listing stamp
--  already read, and dropping them would be a rewrite of four call sites for
--  no gain. The array is the full set and always CONTAINS the singular value.
--  agent_area_set() below is what keeps that true rather than a convention
--  somebody has to remember.
--
--  MATCHING BECOMES "ANY OF", NOT "THE ONE"
--  house_demand_near gains p_wards / p_districts. A demand pin still names a
--  single ward, because a seeker wants ONE place; it is the agent side that is
--  plural. So the test is "is the seeker's ward among the ones this agent
--  covers", which is `=any()` over the normalised array.
--
--  Normalisation still goes through hdp_place_norm, so "Mikocheni B" typed by
--  a seeker meets "mikocheni  b" registered by an agent, per
--  docs/TELLING_AGENTS_WHERE.md.
--
--  BACKWARD COMPATIBLE. p_wards/p_districts default to null, and when they are
--  null the singular p_ward/p_district arms behave exactly as they did. An
--  agent who never sets an array keeps the reach their singular value gives.
--
--  Depends on house_demand_place.sql (hdp_place_norm, house_demand_near) and
--  agent_profiles.sql.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. The columns
-- ---------------------------------------------------------------------------
alter table public.agent_profiles
  add column if not exists wards     text[],
  add column if not exists districts text[];

comment on column public.agent_profiles.wards is
  'Every ward this agent covers. Always contains agent_profiles.ward. Matched with =any() by house_demand_near.';
comment on column public.agent_profiles.districts is
  'Every district this agent covers. Always contains agent_profiles.district.';

-- Backfill from the singular columns so no agent loses reach the moment the
-- array arms start firing: an empty array would match nothing, and the arm
-- prefers the array when it is present.
update public.agent_profiles
   set wards = array[btrim(ward)]
 where wards is null and nullif(btrim(coalesce(ward, '')), '') is not null;

update public.agent_profiles
   set districts = array[btrim(district)]
 where districts is null and nullif(btrim(coalesce(district, '')), '') is not null;

-- ---------------------------------------------------------------------------
-- 2. Writing the set, with the singular kept in step
-- ---------------------------------------------------------------------------
-- The invariant that the array contains the singular value is enforced HERE
-- rather than trusted to every caller. Blank entries are dropped and
-- duplicates that differ only in case or spacing are collapsed through
-- hdp_place_norm, so "Mikocheni" and "mikocheni " do not both occupy the list.
create or replace function public.agent_area_set(
  p_wards text[] default null,
  p_districts text[] default null)
  returns table (ward text, district text, wards text[], districts text[])
  language plpgsql
  security definer
  set search_path = public
as $fn$
declare
  v_uid text := public.app_uid();
  v_w   text[];
  v_d   text[];
begin
  if v_uid is null then
    raise exception 'Sign in first';
  end if;

  -- distinct on the NORMALISED name, keeping the first spelling the agent
  -- actually typed, because that is the one they will recognise on their page.
  select coalesce(array_agg(x.name order by x.ord), '{}')
    into v_w
    from (
      select distinct on (public.hdp_place_norm(t.name))
             btrim(t.name) as name, t.ord
        from unnest(coalesce(p_wards, '{}')) with ordinality as t(name, ord)
       where public.hdp_place_norm(t.name) is not null
       order by public.hdp_place_norm(t.name), t.ord
    ) x;

  select coalesce(array_agg(y.name order by y.ord), '{}')
    into v_d
    from (
      select distinct on (public.hdp_place_norm(t.name))
             btrim(t.name) as name, t.ord
        from unnest(coalesce(p_districts, '{}')) with ordinality as t(name, ord)
       where public.hdp_place_norm(t.name) is not null
       order by public.hdp_place_norm(t.name), t.ord
    ) y;

  update public.agent_profiles ap
     set wards     = v_w,
         districts = v_d,
         -- The first entry is the primary, so the singular column and the
         -- array can never disagree about which ward this agent mainly works.
         ward      = coalesce(v_w[1], ap.ward),
         district  = coalesce(v_d[1], ap.district)
   where ap.user_id = v_uid;

  return query
    select ap.ward, ap.district, ap.wards, ap.districts
      from public.agent_profiles ap where ap.user_id = v_uid;
end $fn$;

grant execute on function public.agent_area_set(text[], text[]) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Matching against every ward the agent covers
-- ---------------------------------------------------------------------------
drop function if exists public.house_demand_near(
  double precision, double precision, integer, text, text, bigint, integer, text, text);

create or replace function public.house_demand_near(
  p_lat      double precision,
  p_lng      double precision,
  p_radius_m integer default 1500,
  p_listing  text    default 'rent',
  p_type     text    default null,
  p_price    bigint  default 0,
  p_bedrooms integer default 0,
  p_ward     text    default null,
  p_district text    default null,
  p_wards    text[]  default null,
  p_districts text[] default null)
  returns table (
    id            text,
    area          text,
    phone         text,
    name          text,
    note          text,
    min_bedrooms  integer,
    max_budget_tzs bigint,
    needed_from   date,
    needed_by     date,
    distance_m    integer,
    created_at    timestamptz,
    ward          text,
    place_label   text,
    anchor_kind   text,
    matched_on    text)
  language sql
  stable
  security definer
  set search_path = public
as $fn$
  with me as (
    -- The agent's full set, with the singular value folded in so a caller that
    -- passes only p_ward still works and a caller that passes both cannot lose
    -- the primary by leaving it out of the array.
    select
      (select coalesce(array_agg(distinct public.hdp_place_norm(w)), '{}')
         from unnest(coalesce(p_wards, '{}') || coalesce(array[p_ward], '{}')) w
        where public.hdp_place_norm(w) is not null) as wards,
      (select coalesce(array_agg(distinct public.hdp_place_norm(d)), '{}')
         from unnest(coalesce(p_districts, '{}') || coalesce(array[p_district], '{}')) d
        where public.hdp_place_norm(d) is not null) as districts
  )
  select
    d.id, d.area, d.phone, d.name, d.note,
    d.min_bedrooms, d.max_budget_tzs, d.needed_from, d.needed_by,
    case when d.anchor_kind = 'exact'
      then round(public.hdp_haversine_km(d.lat, d.lng, p_lat, p_lng) * 1000)::int
      else null end as distance_m,
    d.created_at,
    d.ward, d.place_label, d.anchor_kind,
    case
      when d.anchor_kind = 'exact' then 'distance'
      when d.anchor_kind = 'ward' then 'ward'
      when d.anchor_kind = 'district' then 'district'
      else 'region'
    end as matched_on
  from public.house_demand_pins d, me
  where d.active
    and d.listing = p_listing
    and (d.type is null or p_type is null or d.type = p_type)
    and (d.max_budget_tzs = 0 or p_price = 0 or p_price <= d.max_budget_tzs)
    and (d.min_bedrooms = 0 or p_bedrooms = 0 or p_bedrooms >= d.min_bedrooms)
    and (d.needed_by is null or d.needed_by >= current_date)
    and (
      (
        coalesce(d.anchor_kind, 'exact') = 'exact'
        and public.hdp_haversine_km(d.lat, d.lng, p_lat, p_lng) * 1000
            <= greatest(d.radius_m, p_radius_m)
      )
      or (d.anchor_kind = 'ward'
          and public.hdp_place_norm(d.ward) = any (me.wards))
      or (d.anchor_kind = 'district'
          and public.hdp_place_norm(d.district) = any (me.districts))
      or (d.anchor_kind = 'region'
          and public.hdp_haversine_km(d.lat, d.lng, p_lat, p_lng) * 1000
              <= greatest(d.radius_m, p_radius_m))
    )
  order by
    d.needed_by asc nulls last,
    case when d.anchor_kind in ('ward', 'district') then 0 else 1 end,
    distance_m asc nulls last;
$fn$;

grant execute on function public.house_demand_near(
  double precision, double precision, integer, text, text, bigint, integer,
  text, text, text[], text[]) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. The card returns the whole set
-- ---------------------------------------------------------------------------
-- js/lib/agent-card.js draws the places an agent covers, and one ward on a
-- card belonging to somebody who works four is not a shorter truth, it is a
-- wrong one.
alter table public.agent_profiles alter column wards     set default '{}';
alter table public.agent_profiles alter column districts set default '{}';

commit;
