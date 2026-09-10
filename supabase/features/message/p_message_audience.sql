-- ============================================================================
--  p_message_audience.sql — who a person may gather, who they may advertise
--  to, and the block that overrules both.
-- ============================================================================
--  Rooms and announcements have been admin-only since they shipped. One email
--  is in ADMIN_EMAILS, so in practice nobody could open a room and nobody
--  could announce anything. Opening them to every account is the point of this
--  work, and it cannot be done by deleting two `if not is_admin()` lines: what
--  those lines were doing, badly, was keeping strangers out of each other's
--  inboxes. This file is the replacement, written once so that four call sites
--  cannot drift apart.
--
--  THE RULE, IN ONE SENTENCE EACH
--
--    pm_deals_with     you and this person have both written in the same one
--                      to one conversation, or one of you accepted the other's
--                      invite.
--    pm_may_cast_to    an ANNOUNCEMENT may reach them: pm_deals_with, and no
--                      block in either direction.
--    pm_may_room_with  a ROOM may hold them: pm_may_cast_to, or they have
--                      published a shopfront (an agent, or anyone with a live
--                      listing), and still no block in either direction.
--
--  WHY A ROOM IS WIDER THAN AN ANNOUNCEMENT
--  A room is two-way. The person can answer in it, see who else is in it, and
--  leave it. An announcement is one-way and the reply path is deliberately
--  welded shut (pm_can_announce, p_message_announce.sql). Somebody who has
--  published a listing is already inviting a cold direct message today, from
--  anybody, through the Agents pane; being gathered into a room they can leave
--  is not a larger imposition than that. Being on a stranger's advertising
--  list is, and it is not something they published.
--
--  WHY BEING IN A ROOM TOGETHER IS NOT "DEALING WITH" SOMEBODY
--  This is the trap, and it is not obvious. If room membership counted as a
--  relationship, then: open one silent room holding five hundred strangers,
--  and every one of them is now announceable. The fence would hold for one
--  step and then let the whole country through. So pm_deals_with looks only at
--  DIRECT threads, and rooms grant nothing.
--
--  WHY BOTH PEOPLE HAVE TO HAVE WRITTEN
--  pm_start_direct is unilateral: I can open a conversation with anybody who
--  holds a key, forty an hour, without them ever noticing. If the mere
--  existence of that thread counted, the fence would cost an attacker one
--  extra call per victim. A conversation is two people writing. The invite arm
--  needs no such test, because accepting an invite IS the other person's
--  deliberate act.
--
--  WHAT A BLOCK DOES, AND WHAT IT CANNOT
--  It stops a new direct conversation, being added to a room, and being
--  included in an announcement. It does not un-deliver what already arrived,
--  does not remove either of you from a room you already share, and does not
--  hide either person from the directory — absence there would itself be a
--  "you have been blocked" oracle. The blocked person is not told.
--
--  The block is checked BEFORE the admin exemption, on purpose. An admin who
--  could step over a personal block would make the block a promise with an
--  asterisk on it, and the platform already has a separate, plainly-labelled
--  channel for staff messages (agent_notices, which carries no keys and is not
--  this feature).
--
--  WHERE THE BLOCKS LIVE
--  pm_blocks has RLS on and NOT ONE POLICY, and is revoked from anon and
--  authenticated — the pm_presence pattern. Nothing reads it directly. There
--  is deliberately no "has this person blocked me" call: that is the one
--  question a block exists in order not to answer.
--
--  Idempotent. Safe to re-run. Depends on p_message.sql, _guests, _invites,
--  _finder, _jobs, _presence, and agent/agent_area_directory.sql.
--
--    usage:  node scripts/db/apply_sql.mjs supabase/features/message/p_message_audience.sql
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 0. It cannot run before the finder exists
-- ---------------------------------------------------------------------------
-- pm_my_people is a filter OVER pm_agent_finder rather than a second copy of
-- its counting logic, so a missing finder must fail loudly here rather than
-- silently three functions later.
do $$
begin
  if to_regprocedure('public.pm_agent_finder(text,text,text,integer)') is null then
    raise exception 'Apply supabase/features/agent/agent_area_directory.sql first: pm_my_people reads pm_agent_finder';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. The blocks
-- ---------------------------------------------------------------------------
create table if not exists public.pm_blocks (
  blocker_id text not null,
  blocked_id text not null,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id)
);

-- The reverse direction is the hot one: every reach test asks "has anybody
-- blocked me", which is a lookup on blocked_id.
create index if not exists pm_blocks_blocked_idx on public.pm_blocks (blocked_id);

alter table public.pm_blocks enable row level security;

-- Said out loud rather than left implied, the same way p_message_presence.sql
-- says it: the containment argument above is that there is no policy here, and
-- a policy added later without noticing would quietly end it.
drop policy if exists "pm_blocks readable"   on public.pm_blocks;
drop policy if exists "pm_blocks own read"   on public.pm_blocks;
drop policy if exists "pm_blocks self write" on public.pm_blocks;

revoke all on public.pm_blocks from anon, authenticated;

-- Both directions at once. Symmetric on purpose: a block stops contact, and
-- which of the two pressed the button is not a fact either side needs.
create or replace function public.pm_blocked_between(p_a text, p_b text)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public
as $fn$
  select exists (
    select 1 from public.pm_blocks b
     where (b.blocker_id = p_a and b.blocked_id = p_b)
        or (b.blocker_id = p_b and b.blocked_id = p_a)
  );
$fn$;

-- ---------------------------------------------------------------------------
-- 2. Have these two people actually dealt with each other
-- ---------------------------------------------------------------------------
-- Note what is NOT here: rooms, and one-sided direct threads. The header
-- explains both, and both omissions are load-bearing rather than tidy.
create or replace function public.pm_deals_with(p_other text)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public
as $fn$
  select case
    when coalesce(public.app_uid(), '') = '' then false
    when p_other is null or p_other = public.app_uid() then false
    else
      exists (
        select 1
          from public.pm_threads t
          join public.pm_members me    on me.thread_id = t.id and me.user_id = public.app_uid()
          join public.pm_members other on other.thread_id = t.id and other.user_id = p_other
         where t.kind = 'direct'
           and exists (select 1 from public.pm_messages x
                        where x.thread_id = t.id and x.sender_id = public.app_uid())
           and exists (select 1 from public.pm_messages x
                        where x.thread_id = t.id and x.sender_id = p_other)
      )
      or exists (
        select 1 from public.pm_invites i
         where i.accepted_by is not null
           and (   (i.agent_id = public.app_uid() and i.accepted_by = p_other)
                or (i.agent_id = p_other          and i.accepted_by = public.app_uid()))
      )
  end;
$fn$;

-- Helps the two `exists` above; pm_messages_thread_idx is (thread_id, sent_at)
-- and cannot answer "did this person write here" without reading the thread.
create index if not exists pm_messages_thread_sender_idx
  on public.pm_messages (thread_id, sender_id);

-- ---------------------------------------------------------------------------
-- 3. The two fences
-- ---------------------------------------------------------------------------
-- An announcement, and a first direct conversation.
create or replace function public.pm_may_cast_to(p_other text)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public
as $fn$
  select case
    when coalesce(public.app_uid(), '') = '' then false
    when p_other is null or p_other = public.app_uid() then false
    -- A guest is a browser tab. It may answer an agent (pm_start_direct has
    -- its own arm for that) and it may reach nobody new.
    when public.app_is_guest() then false
    when coalesce((select k.is_guest from public.pm_keys k where k.user_id = p_other), false) then false
    -- Before the admin arm, deliberately. See the header.
    when public.pm_blocked_between(public.app_uid(), p_other) then false
    when public.is_admin() then true
    else public.pm_deals_with(p_other)
  end;
$fn$;

-- A room. Wider by exactly one term: somebody who has published a shopfront.
create or replace function public.pm_may_room_with(p_other text)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public
as $fn$
  select case
    when coalesce(public.app_uid(), '') = '' then false
    when p_other is null or p_other = public.app_uid() then false
    when public.app_is_guest() then false
    when coalesce((select k.is_guest from public.pm_keys k where k.user_id = p_other), false) then false
    when public.pm_blocked_between(public.app_uid(), p_other) then false
    when public.is_admin() then true
    when public.pm_deals_with(p_other) then true
    else coalesce((select k.is_agent from public.pm_keys k where k.user_id = p_other), false)
         or exists (select 1 from public.pm_owner_listings o where o.user_id = p_other)
  end;
$fn$;

-- One round trip for a screen full of rows, so the picker greys people out
-- with the server's own answer instead of a second opinion computed in the
-- browser. Returns a row per id given, in no particular order.
create or replace function public.pm_audience_check(p_users jsonb)
  returns table (user_id text, may_cast boolean, may_room boolean)
  language sql
  stable
  security definer
  set search_path = public
as $fn$
  select u.uid,
         public.pm_may_cast_to(u.uid),
         public.pm_may_room_with(u.uid)
    from (select distinct e.uid
            from jsonb_array_elements_text(coalesce(p_users, '[]'::jsonb)) as e(uid)) u
   where coalesce(public.app_uid(), '') <> ''
   limit 1000;
$fn$;

-- ---------------------------------------------------------------------------
-- 4. The people you deal with, drawn like everybody else
-- ---------------------------------------------------------------------------
-- A FILTER over pm_agent_finder, not a second copy of it. Same column names in
-- the same order, so js/lib/pm-match.js ranks a row from this source and a row
-- from the directory with no branch, and one renderer draws both. `how` is
-- appended last: an older caller reading by name is unaffected.
--
-- Two consequences worth stating. The finder excludes guests and excludes the
-- caller, so this does too, which is right — a guest cannot be advertised to
-- and there is nothing to gain by listing them. And the finder's own ceiling
-- is 500 rows, so a person with more than five hundred contacts sees the first
-- five hundred; if that ever happens the fix is paging, not a bigger number.
create or replace function public.pm_my_people(
  p_query text default null,
  p_limit int  default 300
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
  phone          text,
  how            text
)
  language sql
  stable
  security definer
  set search_path = public
as $fn$
  with linked as (
    select other.user_id as uid, 'thread'::text as how
      from public.pm_threads t
      join public.pm_members me    on me.thread_id = t.id and me.user_id = public.app_uid()
      join public.pm_members other on other.thread_id = t.id and other.user_id <> public.app_uid()
     where t.kind = 'direct'
       and exists (select 1 from public.pm_messages x
                    where x.thread_id = t.id and x.sender_id = public.app_uid())
       and exists (select 1 from public.pm_messages x
                    where x.thread_id = t.id and x.sender_id = other.user_id)
    union all
    select case when i.agent_id = public.app_uid() then i.accepted_by else i.agent_id end, 'invite'
      from public.pm_invites i
     where i.accepted_by is not null
       and (i.agent_id = public.app_uid() or i.accepted_by = public.app_uid())
  ),
  peeps as (
    select uid,
           case when bool_or(how = 'thread') and bool_or(how = 'invite') then 'both'
                when bool_or(how = 'thread') then 'thread'
                else 'invite' end as how
      from linked
     where uid is not null and uid <> public.app_uid()
     group by uid
  )
  select f.user_id, f.display_name, f.region, f.area, f.area_kind, f.district, f.ward,
         f.wards, f.districts, f.lat, f.lng,
         f.is_agent, f.reachable, f.public_key, f.fingerprint,
         f.n_houses, f.n_services, f.n_trucks, f.n_jobs, f.n_verified, f.last_listed_at,
         f.last_seen_at, f.kinds, f.phone, p.how
    from public.pm_agent_finder(null, p_query, null, 500) f
    join peeps p on p.uid = f.user_id
   where not public.pm_blocked_between(public.app_uid(), f.user_id)
   order by f.last_seen_at desc nulls last, f.display_name nulls last
   limit greatest(1, least(coalesce(p_limit, 300), 500));
$fn$;

-- ---------------------------------------------------------------------------
-- 5. Blocking and unblocking
-- ---------------------------------------------------------------------------
create or replace function public.pm_block(p_user text)
  returns boolean
  language plpgsql
  security definer
  set search_path = public
as $fn$
declare v_uid text := public.app_uid();
begin
  if coalesce(v_uid, '') = '' then raise exception 'Sign in first'; end if;
  if public.app_is_guest() then
    raise exception 'A guest session cannot block. Sign in to keep a block.';
  end if;
  if coalesce(p_user, '') = '' or p_user = v_uid then
    raise exception 'Pick someone else';
  end if;
  insert into public.pm_blocks (blocker_id, blocked_id)
  values (v_uid, p_user)
  on conflict do nothing;
  return true;
end $fn$;

create or replace function public.pm_unblock(p_user text)
  returns boolean
  language plpgsql
  security definer
  set search_path = public
as $fn$
declare
  v_uid text := public.app_uid();
  v_n   int;
begin
  if coalesce(v_uid, '') = '' then raise exception 'Sign in first'; end if;
  with del as (
    delete from public.pm_blocks
     where blocker_id = v_uid and blocked_id = p_user
    returning 1
  )
  select count(*)::int into v_n from del;
  return v_n > 0;
end $fn$;

-- Your own blocks and nobody else's. There is no reverse of this function.
create or replace function public.pm_blocks_mine()
  returns table (user_id text, display_name text, region text, blocked_at timestamptz)
  language sql
  stable
  security definer
  set search_path = public
as $fn$
  select b.blocked_id,
         coalesce(k.display_name, ap.name),
         coalesce(k.region, ap.region),
         b.created_at
    from public.pm_blocks b
    left join public.pm_keys k         on k.user_id  = b.blocked_id
    left join public.agent_profiles ap on ap.user_id = b.blocked_id
   where b.blocker_id = public.app_uid()
     and coalesce(public.app_uid(), '') <> ''
   order by b.created_at desc;
$fn$;

-- ---------------------------------------------------------------------------
-- 6. The ceilings
-- ---------------------------------------------------------------------------
-- One-line immutable functions, like pm_group_max() and pm_online_window(),
-- so throttling in an emergency is one `create or replace` and no deploy.
--
-- 60 rather than pm_group_max()'s 1000: "my Kariakoo tenants" and "the truck
-- owners I work with" are working groups. A hundred-person room opened by
-- somebody you have never met is a mailing list wearing a room's clothes.
-- 1000 stays exactly what it is for an admin.
create or replace function public.pm_group_max_open() returns int
  language sql immutable as $$ select 60 $$;

create or replace function public.pm_cast_max_open() returns int
  language sql immutable as $$ select 200 $$;

-- Per rolling day, not per hour. The announcement is the spam vector, and
-- three an hour is seventy-two a day.
create or replace function public.pm_casts_per_day() returns int
  language sql immutable as $$ select 3 $$;

create or replace function public.pm_rooms_per_day() returns int
  language sql immutable as $$ select 3 $$;

-- ---------------------------------------------------------------------------
-- 7. Grants
-- ---------------------------------------------------------------------------
-- The revoke of PUBLIC is here because Postgres grants EXECUTE to PUBLIC on
-- every new function, so `grant ... to authenticated` narrows nothing on its
-- own. It does not get rid of `anon` either: this project's default privileges
-- re-grant execute to anon the moment a function in public is created. The
-- fence that actually holds is inside every function above — app_uid() is null
-- or empty for a caller with no session and each one returns false, raises, or
-- selects no rows. That is the same fence the rest of P-Message stands on.
-- (p_message_invite_forget.sql makes the same note at greater length.)
revoke execute on function public.pm_blocked_between(text, text) from public;
revoke execute on function public.pm_deals_with(text)            from public;
revoke execute on function public.pm_may_cast_to(text)           from public;
revoke execute on function public.pm_may_room_with(text)         from public;
revoke execute on function public.pm_audience_check(jsonb)       from public;
revoke execute on function public.pm_my_people(text, int)        from public;
revoke execute on function public.pm_block(text)                 from public;
revoke execute on function public.pm_unblock(text)               from public;
revoke execute on function public.pm_blocks_mine()               from public;

grant execute on function public.pm_may_cast_to(text)      to authenticated;
grant execute on function public.pm_may_room_with(text)    to authenticated;
grant execute on function public.pm_audience_check(jsonb)  to authenticated;
grant execute on function public.pm_my_people(text, int)   to authenticated;
grant execute on function public.pm_block(text)            to authenticated;
grant execute on function public.pm_unblock(text)          to authenticated;
grant execute on function public.pm_blocks_mine()          to authenticated;

-- pm_blocked_between and pm_deals_with are called only from the functions
-- above, inside the same SECURITY DEFINER chain. Nothing on a screen asks
-- them anything, and pm_deals_with in particular would be a "does this person
-- know that person" probe if a page could call it directly.
grant execute on function public.pm_group_max_open()  to anon, authenticated;
grant execute on function public.pm_cast_max_open()   to anon, authenticated;
grant execute on function public.pm_casts_per_day()   to anon, authenticated;
grant execute on function public.pm_rooms_per_day()   to anon, authenticated;

commit;
