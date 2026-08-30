-- ============================================================================
--  p_message_call.sql — the other way of reaching somebody.
-- ============================================================================
--  Every function that touches the P-Message directory was written to return
--  where a person works and never how to ring them. The reasoning is written
--  out in p_message_storefront.sql and it was good reasoning: a phone number
--  beside an encrypted conversation is the way around the encryption that
--  everybody takes.
--
--  It is being narrowed here, deliberately, because it was answering a
--  different question from the one people actually arrive with. Somebody
--  looking for a canter on Tuesday does not want a conversation. They want a
--  lorry, today, and the fastest honest route to one is the number the driver
--  already printed on the listing.
--
--  WHAT IS RETURNED, EXACTLY
--  The number the person has ALREADY PUBLISHED on their own listings, and
--  nothing else. houses.agent->>'phone', services.owner->>'phone',
--  trucks.owner->>'phone', day_jobs.company_phone. Every one of those columns
--  sits on a world-readable row that anon can select today, printed on
--  house.html / service.html / truck.html / jobs.html beside a Call button.
--  This publishes no number that was not already published; it saves four taps
--  and a guess about which catalogue to look in.
--
--  WHAT IS STILL NOT RETURNED
--  agent_profiles.phone. That is the number somebody typed into a registration
--  form under an RLS policy that says only they and an admin may read it, and
--  no amount of convenience makes reading it here honest. If an agent wants to
--  be called, the way to say so is to put a number on a listing, which is
--  exactly the act that publishes it. See the comment on the column.
--
--  THE ONE FENCE THAT IS NOT OBVIOUS
--  The jobs arm is allowed to supply a number only for somebody who already
--  holds a published P-Message key. That is the same rule pm_agent_listings
--  applies to job cards, and for the same reason: day job ownership lives in
--  day_job_owners precisely so that "account X posted this job" is not
--  published next to a public company_phone. Everyone holding a pm_keys row
--  was already findable and already attributable, so naming their number
--  discloses nothing new; a poster who has never opened P-Message would be a
--  join that exists nowhere else. houses / services / trucks carry
--  owner_user_id on the public row itself, so their pairing is already
--  derivable by anyone and needs no fence.
--
--  WHAT CHANGES
--   1. pm_owner_listings gains `phone` (appended, so create-or-replace works).
--   2. pm_agent_finder returns `phone` — the number from the listing this
--      person touched most recently.
--   3. pm_agent_card returns `phone` too, so the storefront and the row that
--      leads to it cannot print different numbers.
--
--  WHAT DOES NOT CHANGE
--  Every signature above is APPENDED to. The people union, the guest
--  exclusion, the signed-in fence, the self-exclusion, the coarse order, the
--  category CASE and the ranking inputs are all byte-for-byte what
--  p_message_storefront.sql left them.
--
--  Idempotent. Safe to re-run. Depends on p_message.sql, _finder, _jobs,
--  _presence and _storefront — apply this LAST, it recreates two of their
--  functions.
--
--    usage:  node scripts/db/apply_sql.mjs supabase/features/message/p_message_call.sql
-- ============================================================================

begin;

-- Applied out of order this file would drop last_seen_at and kinds off the
-- finder and the agent list would quietly lose its green dot and its words.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'pm_owner_listings'
      and column_name = 'kind'
  ) then
    raise exception
      'Apply message/p_message_storefront.sql first — this file appends to the view it created.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. The listing view carries the number that is on the listing
-- ---------------------------------------------------------------------------
-- Appended at the end: create-or-replace on a view can add columns and can do
-- nothing else, and pm_agent_finder / pm_group_candidates / pm_agent_listings
-- all read this by name.
--
-- Still not a security boundary and still not readable by a client. The
-- revoke is restated because create-or-replace is exactly the operation where
-- a grant quietly comes back if the file forgets.
--
-- nullif(btrim(...), '') rather than the raw value: an empty string is not a
-- phone number, and a Call button wired to one is a button that does nothing.
create or replace view public.pm_owner_listings as
  select owner_user_id as user_id, 'houses'::text as cat,
         coalesce(verified, false) as verified, updated_at,
         type                       as kind,
         id::text                   as listing_id,
         title, region, area, photo,
         price_tzs::numeric         as price_tzs,
         period                     as unit,
         coalesce(available, true)  as active,
         created_at,
         nullif(btrim(coalesce(agent ->> 'phone', '')), '') as phone
    from public.houses   where owner_user_id is not null
  union all
  select owner_user_id, 'services',
         coalesce(verified, false), updated_at,
         category, id::text, title, region, area, photo,
         price_tzs::numeric, rate_type, true, created_at,
         nullif(btrim(coalesce(owner ->> 'phone', '')), '')
    from public.services where owner_user_id is not null
  union all
  select owner_user_id, 'trucks',
         coalesce(verified, false), updated_at,
         truck_type, id::text, title, region, area, photo,
         price_tzs::numeric, period, true, created_at,
         nullif(btrim(coalesce(owner ->> 'phone', '')), '')
    from public.trucks   where owner_user_id is not null
  union all
  select o.owner_user_id, 'jobs',
         false, d.updated_at,
         null::text, d.id::text, d.title, d.region, d.area, null::text,
         d.pay_tzs::numeric, d.pay_note,
         (d.status = 'open' and d.expires_at > now()), d.created_at,
         nullif(btrim(coalesce(d.company_phone, '')), '')
    from public.day_jobs d
    join public.day_job_owners o on o.job_id = d.id;

revoke all on public.pm_owner_listings from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. The finder hands back one number
-- ---------------------------------------------------------------------------
-- One, not a list. A row with three numbers on it is a row that asks the
-- reader to choose between three identical-looking things about a stranger,
-- and there is no fact on the screen that would let them choose well. The one
-- returned is from the listing this person touched most recently, which is the
-- best available answer to "which of these do they still answer".
drop function if exists public.pm_agent_finder(text, text, text, int);

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
    user_id, display_name, region, area, area_kind, district, ward, lat, lng,
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

grant execute on function public.pm_agent_finder(text, text, text, int) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. The storefront says the same number as the row that led to it
-- ---------------------------------------------------------------------------
-- Two screens printing two different phone numbers for one person is worse
-- than either screen printing none, so the pick is the identical subquery.
drop function if exists public.pm_agent_card(text);

create or replace function public.pm_agent_card(p_user text)
  returns table (
    user_id       text,
    display_name  text,
    is_agent      boolean,
    is_guest      boolean,
    reachable     boolean,
    region        text,
    area          text,
    area_kind     text,
    district      text,
    ward          text,
    lat           double precision,
    lng           double precision,
    bio           text,
    n_houses      int,
    n_services    int,
    n_trucks      int,
    n_jobs        int,
    n_verified    int,
    kinds         text[],
    last_seen_at  timestamptz,
    joined_at     timestamptz,
    phone         text
  )
  language sql
  stable
  security definer
  set search_path = public
as $fn$
  with want as (select p_user as user_id)
  select
    w.user_id                                                      as user_id,
    coalesce(k.display_name, ap.name)                              as display_name,
    coalesce(k.is_agent, ap.user_id is not null, false)            as is_agent,
    coalesce(k.is_guest, false)                                    as is_guest,
    (k.public_key is not null)                                     as reachable,
    coalesce(k.region, ap.region)                                  as region,
    ap.area_of_operations, ap.area_kind, ap.district, ap.ward, ap.lat, ap.lng,
    ap.bio,
    (select count(*)::int from public.pm_owner_listings o
      where o.user_id = p_user and o.cat = 'houses')               as n_houses,
    (select count(*)::int from public.pm_owner_listings o
      where o.user_id = p_user and o.cat = 'services')             as n_services,
    (select count(*)::int from public.pm_owner_listings o
      where o.user_id = p_user and o.cat = 'trucks')               as n_trucks,
    (select count(*)::int from public.pm_owner_listings o
      where o.user_id = p_user and o.cat = 'jobs')                 as n_jobs,
    (select count(*)::int from public.pm_owner_listings o
      where o.user_id = p_user and o.verified)                     as n_verified,
    (select array_agg(t.kind order by t.n desc, t.kind)
       from (
         select o.kind, count(*) as n from public.pm_owner_listings o
          where o.user_id = p_user and o.kind is not null and btrim(o.kind) <> ''
          group by o.kind order by count(*) desc, o.kind limit 6
       ) t)                                                        as kinds,
    (select date_trunc('minute', pr.last_seen_at) from public.pm_presence pr
      where pr.user_id = p_user)                                   as last_seen_at,
    least(k.created_at, ap.created_at)                             as joined_at,
    (select o.phone from public.pm_owner_listings o
      where o.user_id = p_user
        and o.phone is not null
        and (o.cat <> 'jobs' or k.public_key is not null)
      order by o.updated_at desc nulls last
      limit 1)                                                     as phone
  from want w
  left join public.pm_keys k          on k.user_id  = w.user_id
  left join public.agent_profiles ap  on ap.user_id = w.user_id
  where (k.user_id is not null or ap.user_id is not null)
    and not coalesce(k.is_guest, false)
    and coalesce(public.app_uid(), '') <> '';
$fn$;

grant execute on function public.pm_agent_card(text) to anon, authenticated;

commit;

-- ============================================================================
-- What this does NOT do, on purpose:
--
--  · It does not read agent_profiles.phone. That number was given under a
--    policy that says only its owner and an admin may read it, and the way to
--    consent to being called is to put a number on a listing.
--
--  · It does not return a WhatsApp handle, though houses.agent and the two
--    owner blobs both carry one. A second button doing almost the same thing
--    is the kind of choice a row cannot help anybody make, and the listing
--    page it links to already offers both.
--
--  · It does not record that anybody called. A call placed from a tel: link
--    leaves this app entirely, and the only way to know it happened would be
--    to route it through something that watched. See the note at the bottom of
--    p_message_finder.sql on why no reply rate is measured here either.
-- ============================================================================
