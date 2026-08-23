-- ============================================================================
--  p_message_presence.sql — "is this agent there right now, and if not, when
--  were they last?"
-- ============================================================================
--  The agent list answers who deals in what and where they work. It cannot
--  answer the question a person actually holds when they are about to type:
--  is anybody going to read this today? A directory of forty names in which
--  thirty-eight have not opened the app since March is not a directory, it is
--  a queue with no server, and the only way to find that out was to write to
--  each of them and wait.
--
--  So: last_seen_at, set when somebody OPENS P-MESSAGE. Not when they load
--  any page of the site, and not when they publish a key — "last opened
--  P-Message" is the exact claim, and it is the only one worth making,
--  because it is the only one that predicts a reply.
--
--  WHERE IT LIVES, AND WHY NOT ON pm_keys
--  A heartbeat is a write every sixty seconds. pm_keys is the row that holds
--  the public key: the one row on this feature where an unexpected UPDATE
--  path is a real problem (p_message_security.sql exists because a PATCH on
--  pm_keys could set is_agent). Keeping the heartbeat off that table means
--  the busiest write in the feature never touches key material, and pm_keys
--  keeps its untouched updated_at.
--
--  WHO CAN SEE IT
--  Nobody, directly. pm_presence has RLS on and NOT ONE POLICY — the same
--  pattern day_job_owners uses. It is read only by SECURITY DEFINER functions
--  that already decide who may see whom:
--    • pm_agent_finder — the directory, signed-in only, already excludes guests
--    • pm_peer         — only people you already share a thread with
--    • pm_inbox        — your own conversations
--  There is no "look up when this person was last online" call, because there
--  is no screen that needs one and it would be a tracking API.
--
--  Truncated to the minute on the way out. Second-level presence tells an
--  observer when you put the phone down; minute-level tells them what they
--  came for. This is metadata either way — see docs/P_MESSAGE.md, which has
--  always said metadata is not encrypted, and now has one more thing in it.
--
--  Idempotent. Safe to re-run. Depends on p_message.sql, _finder, _jobs.
--
--    usage:  node scripts/db/apply_sql.mjs supabase/features/message/p_message_presence.sql
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. The table
-- ---------------------------------------------------------------------------
create table if not exists public.pm_presence (
  user_id      text primary key,
  last_seen_at timestamptz not null default now()
);

alter table public.pm_presence enable row level security;

-- Said out loud rather than left implied: an earlier version of this file
-- could have shipped a "readable" policy without anybody noticing, and the
-- whole containment argument above is that there is no such policy.
drop policy if exists "pm_presence readable"   on public.pm_presence;
drop policy if exists "pm_presence self write" on public.pm_presence;

revoke all on public.pm_presence from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. How long "online" lasts
-- ---------------------------------------------------------------------------
-- One number, in the database, so the client and anything written later
-- cannot disagree about what the green dot means. The client beats every 60s;
-- 150 leaves room for one missed beat before a person who is sitting right
-- there is reported as gone.
create or replace function public.pm_online_window() returns int
  language sql immutable as $$ select 150 $$;

-- ---------------------------------------------------------------------------
-- 3. The heartbeat
-- ---------------------------------------------------------------------------
-- Called by p-message.html on open and every minute it stays open. Cheap by
-- construction: the update is skipped entirely unless the stored value is
-- already older than half the window, so a phone left on the tab for an hour
-- writes sixty times at most and a double-invoked page writes once.
--
-- A guest gets a heartbeat like anybody else. A guest IS a person waiting for
-- a reply, and pm_agent_finder never lists them, so this costs nothing and
-- makes the inbox honest for the agent they are writing to.
create or replace function public.pm_touch_seen() returns timestamptz
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_uid  text := public.app_uid();
  v_when timestamptz;
begin
  if v_uid is null then return null; end if;

  insert into public.pm_presence (user_id, last_seen_at)
  values (v_uid, now())
  on conflict (user_id) do update
    set last_seen_at = now()
    where pm_presence.last_seen_at < now() - make_interval(secs => public.pm_online_window() / 2.0)
  returning last_seen_at into v_when;

  -- ON CONFLICT ... WHERE that does not fire returns no row: the stored value
  -- is recent, which is the answer, not a failure.
  if v_when is null then
    select last_seen_at into v_when from public.pm_presence where user_id = v_uid;
  end if;
  return v_when;
end $$;

grant execute on function public.pm_touch_seen()    to anon, authenticated;
grant execute on function public.pm_online_window() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. The finder carries it
-- ---------------------------------------------------------------------------
-- Return type changes, so drop and recreate. Everything else in the body is
-- unchanged from p_message_jobs.sql; the two additions are last_seen_at and
-- the `kinds` column, which is the other half of what the list was missing —
-- see p_message_storefront.sql, applied after this one. This file adds only
-- the timestamp.
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
  last_seen_at   timestamptz
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
      -- Minute resolution, and null stays null: somebody who has never opened
      -- P-Message since this shipped has no last-seen, and the screen says
      -- nothing about them rather than guessing from when they published a key.
      (select date_trunc('minute', pr.last_seen_at) from public.pm_presence pr
        where pr.user_id = p.user_id)                              as last_seen_at
    from people p
  )
  select
    user_id, display_name, region, area, area_kind, district, ward, lat, lng,
    is_agent, reachable, public_key, fingerprint,
    n_houses, n_services, n_trucks, n_jobs, n_verified, last_listed_at, last_seen_at
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
-- 5. So does pm_peer
-- ---------------------------------------------------------------------------
-- The conversation header is the other place the question gets asked, and it
-- is asked harder there: you are about to send this person something. The
-- fence is unchanged — pm_peer has always required a shared thread, so this
-- discloses presence only to people already in a conversation with you.
drop function if exists public.pm_peer(text);

create or replace function public.pm_peer(p_user_id text)
  returns table (
    user_id      text,
    display_name text,
    public_key   text,
    fingerprint  text,
    is_agent     boolean,
    is_guest     boolean,
    region       text,
    area         text,
    area_kind    text,
    district     text,
    ward         text,
    last_seen_at timestamptz
  )
  language sql
  stable
  security definer
  set search_path = public
as $fn$
  select k.user_id, coalesce(k.display_name, ap.name), k.public_key, k.fingerprint,
         k.is_agent, k.is_guest, coalesce(k.region, ap.region),
         ap.area_of_operations, ap.area_kind, ap.district, ap.ward,
         (select date_trunc('minute', pr.last_seen_at) from public.pm_presence pr
           where pr.user_id = k.user_id)
  from public.pm_keys k
  left join public.agent_profiles ap on ap.user_id = k.user_id
  where k.user_id = p_user_id
    and exists (
      select 1
      from public.pm_members mine
      join public.pm_members theirs on theirs.thread_id = mine.thread_id
      where mine.user_id = public.app_uid() and theirs.user_id = p_user_id
    );
$fn$;

grant execute on function public.pm_peer(text) to anon, authenticated;

commit;
