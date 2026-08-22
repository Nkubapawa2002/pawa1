-- ============================================================================
--  p_message_jobs.sql — day jobs become the fourth thing P-Message knows about.
-- ============================================================================
--  Everything on this site is one of four things: rooms, daily services,
--  moving trucks, and day jobs. P-Message knew about three of them. Not by
--  judgement — by accident of schema. Its model of "who can help me with THIS"
--  is built entirely on pm_owner_listings, pm_owner_listings is built entirely
--  on owner_user_id, and public.day_jobs had no such column, so day jobs could
--  not appear in the finder, could not be a room's scope, could not be an
--  announcement's audience, and contributed no evidence to the ranking.
--
--  The result was a screen that quietly excluded the one category where "who
--  should I write to" is the ONLY question — a person looking for work today
--  cannot browse a board and phone forty companies, and a company that needs
--  twelve people by Thursday cannot either.
--
--  day_jobs_owner.sql gives the table an owner. This file spends it.
--
--  WHAT CHANGES
--   1. pm_owner_listings gains a 'jobs' arm.
--   2. pm_agent_finder() returns n_jobs and accepts p_category = 'jobs'.
--   3. pm_group_candidates() returns n_jobs, and stops keeping its own private
--      copy of the "who owns what" union — it reads the one view, so the
--      roster preview and the ranking can never disagree about a person.
--   4. pm_threads.category accepts 'jobs', so a jobs room can exist.
--
--  WHAT DOES NOT CHANGE
--  The crypto, the thread model, the guest fence, the admin fence, and every
--  signature that is not listed above. The two functions that ARE recreated
--  gain a column and lose nothing; both are called by name with named
--  arguments from js/lib/pm-store.js.
--
--  ONE JUDGEMENT WORTH DISAGREEING WITH
--  A day job counts toward its poster forever, not only while it is open. A
--  company that has posted forty jobs this year is a company that hires,
--  whether or not this Tuesday's post is still taking claims — and day jobs
--  expire after seven days, so counting only live ones would make the whole
--  signal blink out weekly. Recency is not thrown away: it is carried by
--  updated_at, which the client decays on (180-day half-life), which is the
--  right place for "how long ago" to live. Depth saturates at 8 either way.
--
--  Idempotent. Safe to re-run. Depends on p_message.sql, _guests, _groups,
--  _finder, _rooms, and job/day_jobs_owner.sql.
--
--    usage:  node scripts/db/apply_sql.mjs supabase/features/message/p_message_jobs.sql
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 0. Refuse to run against a day_jobs that has no owner
-- ---------------------------------------------------------------------------
-- Applied out of order, every statement below would still "succeed" and the
-- jobs category would silently match nobody for ever. A missing dependency
-- should be an error, not a feature that looks fine and does nothing.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'day_jobs'
      and column_name = 'owner_user_id'
  ) then
    raise exception
      'public.day_jobs has no owner_user_id — apply supabase/features/job/day_jobs_owner.sql first';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Who deals in what — now four kinds of what
-- ---------------------------------------------------------------------------
-- The view gains a column count, so it is a drop and recreate rather than a
-- create-or-replace. Only pm_agent_finder() reads it today and
-- pm_group_candidates() joins it from this file on; both are recreated below.
--
-- `verified` is false for every day job, and that is a fact rather than a
-- placeholder: there is no verification pass for the jobs board. It feeds the
-- Wilson-floored verified share in the client, where a company with ten
-- unverified jobs correctly earns nothing from that term instead of being
-- punished by it — the term only ever adds.
drop view if exists public.pm_owner_listings;
create view public.pm_owner_listings as
  select owner_user_id as user_id, 'houses'::text as cat,
         coalesce(verified, false) as verified, updated_at
    from public.houses   where owner_user_id is not null
  union all
  select owner_user_id, 'services',
         coalesce(verified, false), updated_at
    from public.services where owner_user_id is not null
  union all
  select owner_user_id, 'trucks',
         coalesce(verified, false), updated_at
    from public.trucks   where owner_user_id is not null
  union all
  select owner_user_id, 'jobs',
         false, updated_at
    from public.day_jobs where owner_user_id is not null;

-- Not a security boundary, never queried by a client: only the two
-- SECURITY DEFINER functions below read it, each with its own fence.
revoke all on public.pm_owner_listings from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. The finder, with a fourth count
-- ---------------------------------------------------------------------------
-- Return type gains n_jobs, so drop and recreate. Everything else is the
-- original from p_message_finder.sql, unchanged — the people union, the guest
-- exclusion, the signed-in fence, the self-exclusion, the coarse order.
drop function if exists public.pm_agent_finder(text, text, text, int);

create or replace function public.pm_agent_finder(
  p_region   text default null,
  p_query    text default null,
  p_category text default null,   -- 'houses' | 'services' | 'trucks' | 'jobs' | null
  p_limit    int  default 300
) returns table (
  user_id        text,
  display_name   text,
  region         text,
  area           text,
  area_kind      text,
  district       text,
  ward           text,
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
  last_listed_at timestamptz
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
      ap.lat, ap.lng,
      true                                as is_agent,
      (k.public_key is not null)          as reachable,
      k.public_key, k.fingerprint
    from public.agent_profiles ap
    left join public.pm_keys k on k.user_id = ap.user_id
    union
    -- People who opened P-Message without registering as an agent. A company
    -- that posts day jobs is very often exactly this: not an agent, no area
    -- of operations, but a real account with real listings behind it. Their
    -- n_jobs is now the evidence that says so.
    select
      k.user_id, k.display_name, k.region,
      null::text, null::text, null::text, null::text,
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
        where o.user_id = p.user_id)                               as last_listed_at
    from people p
  )
  select
    user_id, display_name, region, area, area_kind, district, ward, lat, lng,
    is_agent, reachable, public_key, fingerprint,
    n_houses, n_services, n_trucks, n_jobs, n_verified, last_listed_at
  from counted
  where (p_region is null or p_region = '' or region = p_region)
    and (
      p_query is null or p_query = '' or
      display_name ilike '%' || p_query || '%' or
      area         ilike '%' || p_query || '%' or
      district     ilike '%' || p_query || '%' or
      ward         ilike '%' || p_query || '%'
    )
    and (
      p_category is null or p_category = '' or
      case p_category
        when 'houses'   then n_houses   > 0
        when 'services' then n_services > 0
        when 'trucks'   then n_trucks   > 0
        when 'jobs'     then n_jobs     > 0
        else false                      -- an unknown category matches nobody,
      end                               -- rather than quietly matching all
    )
    and coalesce(public.app_uid(), '') <> ''
    and user_id <> coalesce(public.app_uid(), '')
  order by reachable desc, is_agent desc, display_name nulls last
  limit greatest(1, least(coalesce(p_limit, 300), 500));
$fn$;

grant execute on function public.pm_agent_finder(text, text, text, int) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. A room can be scoped to jobs
-- ---------------------------------------------------------------------------
alter table public.pm_threads drop constraint if exists pm_threads_category_check;
alter table public.pm_threads add constraint pm_threads_category_check
  check (category is null or category in ('houses', 'services', 'trucks', 'jobs'));

-- ---------------------------------------------------------------------------
-- 4. The roster preview, from the same view the ranking uses
-- ---------------------------------------------------------------------------
-- This function used to carry its own inline union of houses / services /
-- trucks. Two definitions of "what does this person own" is one too many: the
-- admin's preview of who belongs in a room could drift from the finder's
-- answer about the same people, and nothing would have caught it. It reads
-- pm_owner_listings now, which is where that question is answered.
drop function if exists public.pm_group_candidates(text, text);
create or replace function public.pm_group_candidates(
  p_category text default null,
  p_region   text default null
) returns table (
  user_id      text,
  public_key   text,
  display_name text,
  region       text,
  area         text,
  district     text,
  ward         text,
  is_agent     boolean,
  n_houses     int,
  n_services   int,
  n_trucks     int,
  n_jobs       int,
  listings     int
)
  language sql
  stable
  security definer
  set search_path = public
as $fn$
  select
    k.user_id,
    k.public_key,
    coalesce(k.display_name, ap.name),
    coalesce(k.region, ap.region),
    ap.area_of_operations, ap.district, ap.ward,
    coalesce(k.is_agent, false),
    (select count(*)::int from public.pm_owner_listings o
      where o.user_id = k.user_id and o.cat = 'houses'),
    (select count(*)::int from public.pm_owner_listings o
      where o.user_id = k.user_id and o.cat = 'services'),
    (select count(*)::int from public.pm_owner_listings o
      where o.user_id = k.user_id and o.cat = 'trucks'),
    (select count(*)::int from public.pm_owner_listings o
      where o.user_id = k.user_id and o.cat = 'jobs'),
    (select count(*)::int from public.pm_owner_listings o
      where o.user_id = k.user_id
        and (p_category is null or p_category = '' or o.cat = p_category))
  from public.pm_keys k
  left join public.agent_profiles ap on ap.user_id = k.user_id
  where public.is_admin()
    -- A guest is a browser tab with no name on it. Putting one in a room of
    -- agents is how a meeting becomes a spam target.
    and not coalesce(k.is_guest, false)
    and (p_region is null or p_region = '' or coalesce(k.region, ap.region) = p_region)
    and (
      case
        when p_category is not null and p_category <> '' then
          exists (select 1 from public.pm_owner_listings o
                   where o.user_id = k.user_id and o.cat = p_category)
        else k.is_agent or exists (select 1 from public.pm_owner_listings o
                                    where o.user_id = k.user_id)
      end
    )
  order by coalesce(k.region, ap.region) nulls last, coalesce(k.display_name, ap.name) nulls last;
$fn$;

grant execute on function public.pm_group_candidates(text, text) to authenticated;

commit;

-- ============================================================================
-- What this does NOT do, on purpose:
--
--  · It does not backfill an owner onto the day jobs already in the table.
--    Those were posted by a phone number and there is no honest way to guess
--    the account behind it. See day_jobs_owner.sql.
--
--  · It does not make the jobs board itself messageable — there is no "message
--    this poster" button on jobs.html from here. That is a jobs-page change,
--    and it is now possible for the first time because the owner exists.
--
--  · It still does not report a reply rate, for jobs or for anything else.
--    "Does this person answer" is the signal that would beat every column
--    here, and measuring it means building a record of who wrote to whom,
--    which is the one thing this feature promises not to do.
-- ============================================================================
