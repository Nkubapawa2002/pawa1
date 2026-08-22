-- ============================================================================
--  P-Message — finding the right agent, and finishing the invite loop.
--
--  Two things, both of which the screen could not do before:
--
--  1. pm_agent_finder() — the directory, plus WHAT EACH PERSON ACTUALLY DEALS
--     IN. pm_directory() answers "who is out there"; it cannot answer "who can
--     help me move a fridge", because it never looks at the listings. Someone
--     opening P-Message wants the second question, and was being handed an
--     alphabetical roll of names for it.
--
--     The counts come back as counts, not as a boolean. One truck and eleven
--     trucks are different claims about a person, and the client's ranking
--     (js/lib/pm-match.js) needs the denominator to say how confident the
--     evidence is. A yes/no here would throw that away in the database and no
--     amount of arithmetic on the phone could get it back.
--
--  2. pm_invites_mine() — returns the token HASH.
--
--     pm_invite_revoke(p_token_hash) has existed since invites shipped, and
--     nothing could call it: the only listing of your own invites did not
--     return the hash, so the UI had no way to name the link it wanted to
--     withdraw. A revoke button was therefore impossible to write, which is
--     why there wasn't one. This is the whole fix.
--
--     The hash is safe to hand back to its own creator. It is sha256 of 32
--     random bytes; the preimage is not recoverable, the row is only returned
--     to `agent_id = app_uid()`, and pm_invite_revoke re-checks that ownership
--     itself rather than trusting whoever presents a hash.
--
--  Categories here are houses / services / trucks. That was never a choice:
--  public.day_jobs had no owner column at all — only company_name and
--  company_phone — so there was nobody to attribute a day job to and nobody to
--  message about one, and adding 'jobs' would have meant inventing an owner.
--
--  SUPERSEDED. day_jobs has an owner now (job/day_jobs_owner.sql) and jobs is
--  the fourth category (message/p_message_jobs.sql), which redefines both the
--  view and the function below with an n_jobs column. This file is kept
--  because it is the history of how the finder came to exist and because it is
--  still the correct thing to apply FIRST on a fresh database — but on a live
--  one, p_message_jobs.sql is what is running.
--
--  Apply with:  node scripts/db/apply_sql.mjs supabase/features/message/p_message_finder.sql
-- ============================================================================
begin;

-- ---------------------------------------------------------------------------
-- 1. Who deals in what
-- ---------------------------------------------------------------------------
-- One place that knows how a listing attaches to a person, so the finder and
-- anything after it cannot drift into two different answers. `verified` is
-- carried through because a verified listing is stronger evidence about
-- somebody than an unverified one, and `updated_at` because an agent who last
-- touched a listing fourteen months ago is a worse bet than one who touched it
-- on Tuesday — the client decays on exactly that.
create or replace view public.pm_owner_listings as
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
    from public.trucks   where owner_user_id is not null;

-- The view reads three tables that each carry their own RLS. It is not a
-- security boundary and is never queried directly by a client: only
-- pm_agent_finder() reads it, and that function is SECURITY DEFINER with its
-- own fence. Revoking the direct grants says so out loud.
revoke all on public.pm_owner_listings from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. The finder
-- ---------------------------------------------------------------------------
-- A superset of pm_directory. pm_directory is NOT dropped or altered: it is
-- what the older paths call, its return type is baked into their stubs, and a
-- second function costs a few lines where a changed signature costs a
-- redeploy of everything that reads it.
create or replace function public.pm_agent_finder(
  p_region   text default null,
  p_query    text default null,
  p_category text default null,   -- 'houses' | 'services' | 'trucks' | null
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
  n_verified     int,
  last_listed_at timestamptz
)
  language sql
  stable
  security definer
  set search_path = public
as $fn$
  with people as (
    -- Everyone with an agent profile, whether or not they have opened
    -- P-Message. The ones who have not are still listed, marked unreachable,
    -- exactly as pm_directory does it — a name with a phone number on their
    -- listing is more use than a gap.
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
    -- And people who opened P-Message without ever registering as an agent.
    -- They own no listings, so every count below comes out zero and the
    -- ranking treats them as what they are: reachable, but no evidence they
    -- deal in anything.
    select
      k.user_id, k.display_name, k.region,
      null::text, null::text, null::text, null::text,
      null::double precision, null::double precision,
      k.is_agent, true, k.public_key, k.fingerprint
    from public.pm_keys k
    where not exists (select 1 from public.agent_profiles ap2 where ap2.user_id = k.user_id)
      -- A guest is a browser tab with a nickname on it. They arrive in the
      -- inbox when they write to you; they are not people to go looking for.
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
        where o.user_id = p.user_id and o.verified)                as n_verified,
      (select max(o.updated_at) from public.pm_owner_listings o
        where o.user_id = p.user_id)                               as last_listed_at
    from people p
  )
  select
    user_id, display_name, region, area, area_kind, district, ward, lat, lng,
    is_agent, reachable, public_key, fingerprint,
    n_houses, n_services, n_trucks, n_verified, last_listed_at
  from counted
  where (p_region is null or p_region = '' or region = p_region)
    and (
      p_query is null or p_query = '' or
      display_name ilike '%' || p_query || '%' or
      area         ilike '%' || p_query || '%' or
      district     ilike '%' || p_query || '%' or
      ward         ilike '%' || p_query || '%'
    )
    -- A category filter means "shows evidence of dealing in this", not "says
    -- they do". Nobody has to be taken at their word here because the
    -- listings are the claim.
    and (
      p_category is null or p_category = '' or
      case p_category
        when 'houses'   then n_houses   > 0
        when 'services' then n_services > 0
        when 'trucks'   then n_trucks   > 0
        else false                      -- an unknown category matches nobody,
      end                               -- rather than quietly matching all
    )
    -- Signed-in callers only, guests included: a guest is signed in, just not
    -- identified. What stays shut out is the public anon key on its own. Same
    -- fence as pm_directory, and it has to stay the same one — a looser copy
    -- here would be a way around the tighter original.
    and coalesce(public.app_uid(), '') <> ''
    and user_id <> coalesce(public.app_uid(), '')
  -- Only a coarse order. The real ordering is a probability computed on the
  -- device from these columns, because it depends on what the person is
  -- looking for and the database was not told that.
  order by reachable desc, is_agent desc, display_name nulls last
  limit greatest(1, least(coalesce(p_limit, 300), 500));
$fn$;

grant execute on function public.pm_agent_finder(text, text, text, int) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Your invite links, including the handle needed to withdraw one
-- ---------------------------------------------------------------------------
-- The return type gains a column, so this is a drop and recreate rather than a
-- create-or-replace. Nothing else selects from it.
drop function if exists public.pm_invites_mine(int);

create or replace function public.pm_invites_mine(p_limit int default 50)
  returns table (
    token_hash  text,
    label       text,
    state       text,
    thread_id   uuid,
    created_at  timestamptz,
    expires_at  timestamptz,
    guest_name  text
  )
  language sql
  stable
  security definer
  set search_path = public
as $fn$
  select
    i.token_hash,
    i.label,
    case
      when i.revoked_at is not null  then 'revoked'
      when i.accepted_at is not null then 'used'
      when i.expires_at < now()      then 'expired'
      else 'open'
    end,
    i.thread_id, i.created_at, i.expires_at,
    gk.display_name
  from public.pm_invites i
  left join public.pm_keys gk on gk.user_id = i.accepted_by
  where i.agent_id = public.app_uid()
  order by i.created_at desc
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$fn$;

grant execute on function public.pm_invites_mine(int) to authenticated;

commit;

-- ============================================================================
-- What this does NOT do, on purpose:
--
--  · It does not rank. Ranking needs to know what the person is looking for
--    and how much a near-miss on the ward is worth against a hit on the
--    category, and that is a judgement, not a fact about the data. It lives in
--    js/lib/pm-match.js where it can be read, argued with and unit-tested
--    without a database.
--
--  · It did not count day jobs, because day_jobs had no owner. That is fixed
--    in p_message_jobs.sql, which supersedes both objects above; the reasoning
--    for the fix, and for what it deliberately leaves alone, lives there.
--
--  · It does not report a reply rate, which is the signal that would beat all
--    of these — "does this person answer" is the actual question. It is not
--    here because measuring it means reading who replied to whom, and this
--    feature's whole promise is that we do not build that picture. An agent
--    ranked by their listings is a worse ranking honestly obtained.
-- ============================================================================
