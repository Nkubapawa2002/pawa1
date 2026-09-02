-- ============================================================================
--  house_demand_place.sql — telling an agent where you mean, when the map
--  has never heard of it.
-- ============================================================================
--  THE PROBLEM, STATED PLAINLY
--  Half the places people in Tanzania actually live are not on any map anybody
--  is geocoding against. "Kwa Ndege", "Mwenge kwa Mafuriko", "Sokoni kwa
--  Mchina" are exact addresses to a person and to every agent working that
--  street, and they are nothing at all to LocationIQ.
--
--  js/lib/request-place.js already knew this and did the only safe thing it
--  could: it kept the REGION as a routing key and let the point fall back to
--  the region's centroid when the typed name geocoded to nothing.
--
--  That fallback is where the requests were going to die. house_demand_near
--  matches purely on geometry:
--
--      haversine(d.lat, d.lng, listing) <= greatest(d.radius_m, p_radius_m)
--
--  and a region centroid is not a location, it is an average. Dar es Salaam's
--  centroid is roughly Kinondoni. A seeker who wants a room in Kigamboni and
--  names a street the geocoder misses gets a pin ~15 km from where they mean,
--  and then either matches every agent in the wrong half of the city or, with
--  a tight radius, nobody at all. The seeker is told "Request sent" both ways.
--
--  THE RULE THIS FILE ENFORCES
--  When the place cannot be found on the map, the request must carry the
--  smallest administrative unit that CAN be named exactly, and the local name
--  is carried beside it rather than instead of it:
--
--      ward if the seeker knows it, else district, exactly, from the list
--      + the name of the place they actually want, in their own words
--
--  Ward first because that is the unit agents work in: agent_profiles has
--  carried `ward` and `district` since it was written, and until now a demand
--  pin had no ward column to match it against, so the finest routing key on
--  the supply side had nothing to meet on the demand side.
--
--  WHY THE MATCH BECOMES TWO-ARMED, AND WHY THAT IS THE WHOLE POINT
--  A distance is only evidence when the point it is measured from is real.
--  So the pin now records HOW its coordinates were obtained:
--
--    anchor_kind = 'exact'     a dragged pin, a GPS fix, a picked suggestion,
--                              or text that genuinely geocoded. The coordinates
--                              mean something, so geometry decides, exactly as
--                              before. Nothing that works today changes.
--
--    anchor_kind = 'ward'      the point is a stand-in. Geometry is FICTION
--    anchor_kind = 'district'  here and matching on it is not "approximate",
--                              it is wrong. The named unit decides instead.
--
--  This is why the fix is not "widen the radius". Widening a radius around the
--  wrong centre buys more wrong agents. Matching on the name the seeker could
--  state exactly is the only thing that gets narrower AND more correct at once.
--
--  NAMES ARE COMPARED NORMALISED, because a person types "Mikocheni B", an
--  agent registered "mikocheni  b", and a form somewhere appended "Ward". See
--  hdp_place_norm below for exactly what is stripped.
--
--  BACKWARD COMPATIBLE ON PURPOSE. anchor_kind defaults to 'exact' for every
--  row that already exists, so every pin written before today keeps the
--  geometric behaviour it was written under. p_ward and p_district are
--  optional, so a caller that has not been updated still compiles and still
--  matches on distance.
--
--  Depends on house_demand.sql (house_demand_pins, hdp_haversine_km).
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. What the pin now remembers about its own coordinates
-- ---------------------------------------------------------------------------
alter table public.house_demand_pins
  add column if not exists ward        text,
  add column if not exists place_label text,
  add column if not exists anchor_kind text not null default 'exact';

comment on column public.house_demand_pins.ward is
  'Ward named exactly by the seeker. The finest unit agent_profiles also carries.';
comment on column public.house_demand_pins.place_label is
  'The place in the seeker''s own words. Often unmappable, and often the only thing an agent will recognise.';
comment on column public.house_demand_pins.anchor_kind is
  'How lat/lng were obtained: exact | ward | district | region. Anything but exact means the point is a stand-in and distance is not evidence.';

alter table public.house_demand_pins
  drop constraint if exists house_demand_pins_anchor_kind_check;
alter table public.house_demand_pins
  add constraint house_demand_pins_anchor_kind_check
  check (anchor_kind in ('exact', 'ward', 'district', 'region'));

-- A pin that admits its point is a stand-in has to say which unit to use
-- instead, or it is unroutable: no trustworthy geometry AND no name to match.
alter table public.house_demand_pins
  drop constraint if exists house_demand_pins_anchor_named_check;
alter table public.house_demand_pins
  add constraint house_demand_pins_anchor_named_check
  check (
    anchor_kind <> 'ward'     or nullif(btrim(ward), '') is not null
  );
alter table public.house_demand_pins
  drop constraint if exists house_demand_pins_anchor_district_check;
alter table public.house_demand_pins
  add constraint house_demand_pins_anchor_district_check
  check (
    anchor_kind <> 'district' or nullif(btrim(district), '') is not null
  );

-- ---------------------------------------------------------------------------
-- 2. Comparing two names that mean the same place
-- ---------------------------------------------------------------------------
-- Everything here was met in real data. The suffixes go because a ward is
-- written "Mikocheni", "Mikocheni Ward" and "Kata ya Mikocheni" by three
-- different forms; punctuation goes because "Mikocheni-B" and "Mikocheni B"
-- are one place; and the space collapse is what makes a double-typed space
-- stop being a different ward.
--
-- IMMUTABLE so it can be used in an index later if these tables ever grow
-- past the point where a sequential scan is free.
create or replace function public.hdp_place_norm(p text)
  returns text
  language sql
  immutable
  set search_path = public
as $fn$
  select nullif(
    btrim(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            lower(btrim(coalesce(p, ''))),
            '(^|\s)(kata ya|wilaya ya|mtaa wa)\s+', '\1', 'g'   -- Swahili prefixes
          ),
          '\s+(ward|district|kata|wilaya|mtaa)$', '', 'g'        -- either-language suffix
        ),
        '[^a-z0-9]+', ' ', 'g'                                   -- punctuation to space
      )
    ), '');
$fn$;

-- ---------------------------------------------------------------------------
-- 3. The two-armed match
-- ---------------------------------------------------------------------------
-- p_ward and p_district are the AGENT's own registered units (agent_profiles
-- carries both). They are optional so an un-updated caller keeps working, and
-- when they are absent the named arm simply cannot fire, which degrades to
-- exactly today's behaviour rather than to a wrong answer.
drop function if exists public.house_demand_near(double precision, double precision, integer, text, text, bigint, integer);

create or replace function public.house_demand_near(
  p_lat      double precision,
  p_lng      double precision,
  p_radius_m integer default 1500,
  p_listing  text    default 'rent',
  p_type     text    default null,
  p_price    bigint  default 0,
  p_bedrooms integer default 0,
  p_ward     text    default null,
  p_district text    default null)
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
  select
    d.id, d.area, d.phone, d.name, d.note,
    d.min_bedrooms, d.max_budget_tzs, d.needed_from, d.needed_by,
    -- Still reported, because an agent wants to know how far it is even when
    -- distance is not what matched it. It is NULL when the point is a
    -- stand-in, so a fabricated "14 km" never appears next to a request that
    -- was matched by name.
    case when d.anchor_kind = 'exact'
      then round(public.hdp_haversine_km(d.lat, d.lng, p_lat, p_lng) * 1000)::int
      else null end as distance_m,
    d.created_at,
    d.ward, d.place_label, d.anchor_kind,
    -- Which arm caught it. The dashboard says "in your ward" rather than
    -- inventing a distance, and the seeker's own words come with it.
    case
      when d.anchor_kind = 'exact' then 'distance'
      when d.anchor_kind = 'ward' then 'ward'
      when d.anchor_kind = 'district' then 'district'
      else 'region'
    end as matched_on
  from public.house_demand_pins d
  where d.active
    and d.listing = p_listing
    and (d.type is null or p_type is null or d.type = p_type)
    and (d.max_budget_tzs = 0 or p_price = 0 or p_price <= d.max_budget_tzs)
    and (d.min_bedrooms = 0 or p_bedrooms = 0 or p_bedrooms >= d.min_bedrooms)
    and (d.needed_by is null or d.needed_by >= current_date)
    and (
      -- Arm 1: the point is real, so distance is evidence. Unchanged.
      (
        coalesce(d.anchor_kind, 'exact') = 'exact'
        and public.hdp_haversine_km(d.lat, d.lng, p_lat, p_lng) * 1000
            <= greatest(d.radius_m, p_radius_m)
      )
      -- Arm 2: the point is a stand-in, so the named unit decides. A ward pin
      -- matches only a ward; it deliberately does NOT fall through to district,
      -- because somebody who could name their ward meant that ward.
      or (d.anchor_kind = 'ward'
          and public.hdp_place_norm(d.ward) is not null
          and public.hdp_place_norm(d.ward) = public.hdp_place_norm(p_ward))
      or (d.anchor_kind = 'district'
          and public.hdp_place_norm(d.district) is not null
          and public.hdp_place_norm(d.district) = public.hdp_place_norm(p_district))
      -- Arm 3: legacy region-centroid pins, written before this file existed.
      -- They keep the geometry they were created under, or they would vanish
      -- from every dashboard the moment this ran.
      or (d.anchor_kind = 'region'
          and public.hdp_haversine_km(d.lat, d.lng, p_lat, p_lng) * 1000
              <= greatest(d.radius_m, p_radius_m))
    )
  -- Most urgent first, then the ones matched by name (a named ward is a
  -- stronger statement of intent than being inside a radius), then nearest.
  order by
    d.needed_by asc nulls last,
    case when d.anchor_kind in ('ward', 'district') then 0 else 1 end,
    distance_m asc nulls last;
$fn$;

grant execute on function public.house_demand_near(
  double precision, double precision, integer, text, text, bigint, integer, text, text)
  to anon, authenticated;
grant execute on function public.hdp_place_norm(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. The write path learns the three new fields
-- ---------------------------------------------------------------------------
-- js/lib/request-place.js calls house_demand_create FIRST and only falls back
-- to a direct insert when the RPC is missing. So the RPC has to accept the new
-- fields or they would never be written and everything above would be dead
-- schema. Three new parameters, all at the end, all defaulted: an old client
-- keeps working and simply writes anchor_kind='exact', which is what it means.
--
-- The anchor is VALIDATED here rather than trusted. A client that says 'ward'
-- without naming one would otherwise write a row that can never match anything
-- and can never be found again, which is worse than the centroid it replaced.
-- The 16-argument version is DROPPED, not left beside this one. Two overloads
-- whose extra arguments are all defaulted are ambiguous to PostgREST the
-- moment a client sends only the original sixteen: it answers "could not
-- choose the best candidate function" and every request fails. The new
-- signature is a strict superset, so nothing is lost by removing the old one.
drop function if exists public.house_demand_create(
  text, double precision, double precision, text, text, text, text, integer, text,
  text, integer, bigint, text, text, date, date);

create or replace function public.house_demand_create(
  p_id text, p_lat double precision, p_lng double precision, p_phone text,
  p_region text default null, p_area text default null, p_district text default null,
  p_radius_m integer default 3000, p_listing text default 'rent',
  p_type text default null, p_min_bedrooms integer default 0,
  p_max_budget_tzs bigint default 0, p_name text default null,
  p_note text default null, p_needed_from date default null, p_needed_by date default null,
  p_ward text default null, p_place_label text default null,
  p_anchor_kind text default 'exact')
  returns text
  language plpgsql
  security definer
  set search_path = public
as $fn$
declare
  v_id      text := coalesce(nullif(btrim(p_id), ''), 'dp-' || replace(gen_random_uuid()::text, '-', ''));
  v_listing text := lower(coalesce(p_listing, 'rent'));
  v_digits  text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  v_anchor  text := lower(coalesce(nullif(btrim(p_anchor_kind), ''), 'exact'));
  v_ward    text := nullif(btrim(coalesce(p_ward, '')), '');
  v_dist    text := nullif(btrim(coalesce(p_district, '')), '');
begin
  if p_lat is null or p_lng is null then
    raise exception 'lat/lng required' using errcode = '22023';
  end if;
  if char_length(v_digits) < 9 then
    raise exception 'a reachable phone is required' using errcode = '22023';
  end if;
  if v_listing not in ('rent', 'sale') then v_listing := 'rent'; end if;
  if v_anchor not in ('exact', 'ward', 'district', 'region') then v_anchor := 'exact'; end if;

  -- An anchor that names nothing is not an anchor. Falling back to 'region'
  -- rather than raising keeps a half-filled form from losing the request; the
  -- seeker still reaches the region's agents, which is where they were before.
  if v_anchor = 'ward' and v_ward is null then v_anchor := 'region'; end if;
  if v_anchor = 'district' and v_dist is null then v_anchor := 'region'; end if;

  insert into public.house_demand_pins (
    id, lat, lng, area, region, district, ward, place_label, anchor_kind,
    radius_m, listing, type, min_bedrooms, max_budget_tzs,
    phone, name, note, needed_from, needed_by)
  values (
    v_id, p_lat, p_lng, nullif(btrim(coalesce(p_area, '')), ''),
    nullif(btrim(coalesce(p_region, '')), ''), v_dist, v_ward,
    nullif(btrim(coalesce(p_place_label, '')), ''), v_anchor,
    greatest(coalesce(p_radius_m, 3000), 100), v_listing,
    nullif(btrim(coalesce(p_type, '')), ''),
    greatest(coalesce(p_min_bedrooms, 0), 0),
    greatest(coalesce(p_max_budget_tzs, 0), 0),
    p_phone, nullif(btrim(coalesce(p_name, '')), ''),
    nullif(btrim(coalesce(p_note, '')), ''), p_needed_from, p_needed_by)
  on conflict (id) do nothing;

  return v_id;
end $fn$;

grant execute on function public.house_demand_create(
  text, double precision, double precision, text, text, text, text, integer, text,
  text, integer, bigint, text, text, date, date, text, text, text) to anon, authenticated;

commit;
