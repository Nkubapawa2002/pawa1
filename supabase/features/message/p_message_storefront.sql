-- ============================================================================
--  p_message_storefront.sql — what an agent actually DOES, and a way to go
--  and look at it.
-- ============================================================================
--  Two gaps, one cause.
--
--  1. The agent list said "4 services". Four services of WHAT. A plumber and
--     a hairdresser and a night guard all read "4 services" on the same row,
--     which is the count of a thing whose identity was thrown away one join
--     earlier. Somebody scanning for a plumber had to open four conversations
--     to find out. pm_owner_listings carried cat ('services') and dropped
--     kind ('plumbing') — the column that answers the question.
--
--  2. There was nowhere to send a person who wanted to look before writing.
--     Every other marketplace answers "who is this" with a storefront; here
--     the only way to see an agent's work was to know they existed, guess
--     which catalogue they were in, and scroll. So: agent.html?u=<user id>,
--     and the two functions at the bottom of this file are what fills it.
--
--  ABOUT THE "LINK IN THE BIO"
--  The bio is the agent's own words. The LINK is not: it is generated, it is
--  always agent.html?u=<their own id>, and there is no column anywhere in
--  this file that stores a URL somebody typed. A free-text link field on a
--  public directory row is a phishing surface with a marketing name — it puts
--  an attacker-chosen destination behind a name the app vouched for. The link
--  people asked for is "take me to this agent's services", and that
--  destination is knowable from the id alone, so it is derived, never stored.
--  Bios are plain text and are escaped at render; no markup, no anchors.
--
--  WHAT CHANGES
--   1. agent_profiles gains bio (<= 400 chars).
--   2. pm_owner_listings gains kind + enough of a listing to draw a card.
--      Columns are APPENDED — create-or-replace on a view cannot reorder or
--      retype the existing four, and pm_agent_finder / pm_group_candidates
--      both read it by name.
--   3. pm_agent_finder returns kinds[] — the top four kinds this person deals
--      in, narrowed to the chosen category when there is one. "4 services"
--      becomes "plumbing · electrical".
--   4. pm_agent_card() and pm_agent_listings() — the storefront.
--
--  WHAT IS DELIBERATELY NOT RETURNED
--  A phone number. Not from the card, not from the listings. Every function
--  that touches the P-Message directory returns where somebody works and
--  never how to ring them, because the point of the feature is a conversation
--  that is encrypted, and a phone number beside it is the way around that
--  which everybody takes. The listing pages themselves still show one; that
--  is their business and it is a page the person chose to open.
--
--  Idempotent. Safe to re-run. Depends on p_message.sql, _finder, _jobs,
--  _presence (this file recreates pm_agent_finder including last_seen_at, so
--  apply presence FIRST or the column silently disappears).
--
--    usage:  node scripts/db/apply_sql.mjs supabase/features/message/p_message_storefront.sql
-- ============================================================================

begin;

-- Applied out of order, everything below would succeed and the agent list
-- would quietly lose the green dot it had yesterday.
do $$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'pm_presence'
  ) then
    raise exception 'Apply message/p_message_presence.sql first — this file recreates pm_agent_finder and needs its last_seen_at column.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. The bio
-- ---------------------------------------------------------------------------
alter table public.agent_profiles add column if not exists bio text;

alter table public.agent_profiles drop constraint if exists agent_profiles_bio_len;
alter table public.agent_profiles add constraint agent_profiles_bio_len
  check (bio is null or char_length(bio) <= 400);

comment on column public.agent_profiles.bio is
  'The agent''s own description of what they do. Plain text, escaped at render. Never a URL — see p_message_storefront.sql.';

-- ---------------------------------------------------------------------------
-- 2. The listing view learns what a listing IS
-- ---------------------------------------------------------------------------
-- Still not a security boundary and still not readable by a client: the
-- revoke below is re-stated because create-or-replace on a view is exactly
-- the operation where a grant quietly comes back if the file forgets.
--
-- `kind` is free text on houses and trucks (a 40-char check, nothing more) and
-- a fixed set on services. It is passed through as stored and labelled on the
-- client (js/lib/listing-kinds.js) — translating it here would bake English
-- into a table that Swahili has to read too.
create or replace view public.pm_owner_listings as
  select owner_user_id as user_id, 'houses'::text as cat,
         coalesce(verified, false) as verified, updated_at,
         type                       as kind,
         id::text                   as listing_id,
         title, region, area, photo,
         price_tzs::numeric         as price_tzs,
         period                     as unit,
         coalesce(available, true)  as active,
         created_at
    from public.houses   where owner_user_id is not null
  union all
  select owner_user_id, 'services',
         coalesce(verified, false), updated_at,
         category, id::text, title, region, area, photo,
         price_tzs::numeric, rate_type, true, created_at
    from public.services where owner_user_id is not null
  union all
  select owner_user_id, 'trucks',
         coalesce(verified, false), updated_at,
         truck_type, id::text, title, region, area, photo,
         price_tzs::numeric, period, true, created_at
    from public.trucks   where owner_user_id is not null
  union all
  -- A day job has no kind: the board has no categories, only titles somebody
  -- typed. Inventing one by keyword-matching the title would be a guess
  -- printed as a fact, so the column is null and the client says nothing
  -- rather than something plausible.
  select o.owner_user_id, 'jobs',
         false, d.updated_at,
         null::text, d.id::text, d.title, d.region, d.area, null::text,
         d.pay_tzs::numeric, d.pay_note,
         (d.status = 'open' and d.expires_at > now()), d.created_at
    from public.day_jobs d
    join public.day_job_owners o on o.job_id = d.id;

revoke all on public.pm_owner_listings from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. The finder says what kind of work
-- ---------------------------------------------------------------------------
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
  kinds          text[]
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
      -- The kinds they deal in most, commonest first, four at most. Narrowed
      -- to the chosen category when there is one: with the Trucks chip on,
      -- "canter · 7ton" is the answer and "cleaning" is noise from the other
      -- half of their business.
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
         ) t)                                                      as kinds
    from people p
  )
  select
    user_id, display_name, region, area, area_kind, district, ward, lat, lng,
    is_agent, reachable, public_key, fingerprint,
    n_houses, n_services, n_trucks, n_jobs, n_verified, last_listed_at,
    last_seen_at, kinds
  from counted
  where (p_region is null or p_region = '' or region = p_region)
    and (
      p_query is null or p_query = '' or
      display_name ilike '%' || p_query || '%' or
      area         ilike '%' || p_query || '%' or
      district     ilike '%' || p_query || '%' or
      ward         ilike '%' || p_query || '%' or
      -- Searching the work itself. "plumber" was previously a search over
      -- names and place names only, so it matched a person called Plumber and
      -- nobody who does plumbing.
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
-- 4. The storefront: who they are
-- ---------------------------------------------------------------------------
-- Signed-in only, like every other directory call here. It answers for any
-- id, including one that turns out to be nobody — a caller who guesses gets
-- an empty result, not an error that confirms the guess is close.
--
-- reachable is the whole difference between "write to them" and "here is
-- their catalogue": somebody with listings and no P-Message key can be looked
-- at and cannot be messaged, and the page has to say which.
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
    joined_at     timestamptz
  )
  language sql
  stable
  security definer
  set search_path = public
as $fn$
  -- Driven from the requested id rather than from a full join of two tables:
  -- either side may be missing (an agent who has never opened P-Message, or
  -- somebody who opened it and never registered), and both are answers.
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
    least(k.created_at, ap.created_at)                             as joined_at
  from want w
  left join public.pm_keys k          on k.user_id  = w.user_id
  left join public.agent_profiles ap  on ap.user_id = w.user_id
  where (k.user_id is not null or ap.user_id is not null)
    -- A guest is a browser tab with a nickname on it. It has no storefront and
    -- no listings, and answering for one would turn a disposable identity into
    -- a page somebody can link to.
    and not coalesce(k.is_guest, false)
    and coalesce(public.app_uid(), '') <> '';
$fn$;

grant execute on function public.pm_agent_card(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. The storefront: what they list
-- ---------------------------------------------------------------------------
-- Everything they have in every catalogue, newest first, ready to draw as
-- cards that link to house.html / service.html / truck.html.
--
-- The jobs arm carries one extra fence, and it is the same one day_job_posters
-- uses: a day job is only attributed to its poster when that poster already
-- holds a published P-Message key. Everyone in that set was already findable
-- by name in pm_agent_finder, so naming them here discloses nothing new —
-- whereas attributing a job to an account that has never opened P-Message
-- would publish an ownership fact that has appeared nowhere else, next to a
-- company phone number that IS public. That pairing is what
-- day_jobs_owner_table.sql exists to prevent.
create or replace function public.pm_agent_listings(
  p_user  text,
  p_limit int default 60
)
  returns table (
    cat        text,
    listing_id text,
    title      text,
    kind       text,
    price_tzs  numeric,
    unit       text,
    photo      text,
    region     text,
    area       text,
    verified   boolean,
    active     boolean,
    created_at timestamptz
  )
  language sql
  stable
  security definer
  set search_path = public
as $fn$
  select o.cat, o.listing_id, o.title, o.kind, o.price_tzs, o.unit, o.photo,
         o.region, o.area, o.verified, o.active, o.created_at
  from public.pm_owner_listings o
  where o.user_id = p_user
    and coalesce(public.app_uid(), '') <> ''
    and (
      o.cat <> 'jobs'
      or exists (select 1 from public.pm_keys k
                  where k.user_id = p_user and k.public_key is not null)
    )
  order by o.active desc, o.created_at desc
  limit greatest(1, least(coalesce(p_limit, 60), 200));
$fn$;

grant execute on function public.pm_agent_listings(text, int) to anon, authenticated;

commit;
