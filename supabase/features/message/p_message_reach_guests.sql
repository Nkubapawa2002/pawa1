-- ============================================================================
--  p_message_reach_guests.sql — the invite could never produce a reachable
--  person, and that is why rooms and announcements looked broken.
-- ============================================================================
--  THE REPORT
--  "All announcements and rooms in P-Message aren't working." They were not
--  broken. Every function was applied, every grant correct, every argument
--  name matching. What was empty was the AUDIENCE, and it was empty by
--  construction rather than by accident.
--
--  THE NUMBERS THAT SHOW IT (production, 2026-09-10)
--    pm_keys rows ............... 15
--    of which is_guest .......... 14
--    accepted invites ............ 0
--    direct threads both wrote in  0
--    broadcasts ever sent ........ 0
--
--  So the directory of people an announcement could reach held exactly one
--  row, and that row was a Clerk-era leftover with no published key. The Send
--  button is disabled while the basket is empty (js/pages/p-message.js), and
--  the basket could not be filled. That is the whole of "not working".
--
--  THE CONTRADICTION THIS FILE RESOLVES
--  p_message_audience.sql made "somebody you deal with" the fence, and named
--  two ways to become one: both write in a direct thread, or ACCEPT AN INVITE.
--  The invite is the one that matters here, because it is the only route for
--  somebody who does not have an account yet — it is what the whole invite
--  feature exists for.
--
--  But an invited customer signs in as a GUEST. That is not incidental, it is
--  what the invite link does: js/pages/p-message.js handleInviteLink() calls
--  the anonymous sign-in and then publishes a key with is_guest = true. And
--  pm_may_cast_to refused every guest OUTRIGHT, in a clause standing before
--  the pm_deals_with test it would otherwise have passed.
--
--  So: an agent makes a link. A customer opens it, accepts, and the two of
--  them talk. pm_deals_with(customer) is now true — and the agent still cannot
--  put that customer in a room or an announcement, forever. The invite feature
--  and the audience fence contradicted each other, and the fence won.
--
--  WHAT CHANGES, EXACTLY
--  A guest is no longer refused as a recipient. A guest is refused as a
--  STRANGER, which is what the clause was there to do:
--
--      guest recipient  ->  allowed only if pm_deals_with(them)
--
--  Everything that made the fence worth having is untouched:
--    · a guest still cannot SEND an announcement or open a room (app_is_guest
--      at the top of both predicates, and again in both functions).
--    · nobody can be reached cold. pm_deals_with still needs two people who
--      both wrote, or an invite the other person deliberately accepted.
--    · a block still overrules everything, still ahead of the admin arm.
--    · room membership still grants nothing (the 500-strangers trap).
--
--  WHY THE RULE MOVES OUT OF THE THREE CALLERS
--  pm_broadcast, pm_group_create and pm_group_add each carried their OWN copy
--  of `not coalesce(k.is_guest, false)`, so the same question was answered in
--  four places. Changing the predicate alone would have changed nothing at
--  all. The three inline copies are removed here and the predicates are now
--  the only place the rule lives, which is the same correction
--  p_message_jobs.sql made when pm_group_candidates stopped keeping its own
--  copy of the who-owns-what union.
--
--  WHAT IS HONESTLY WORSE, AND IS ACCEPTED
--  A guest's private key lives in one browser and dies when that browser is
--  cleared; an announcement sealed to a guest becomes unreadable when their
--  session ends. That was already true of every direct message to a guest, and
--  P-Message already draws an unreadable message rather than hiding it. The
--  alternative on offer was an audience of nobody, which is not safer, only
--  emptier.
--
--  THE ASSUMPTION THIS BREAKS, AND REPAIRS IN THE SAME BREATH
--  p_message_guest_end.sql states in its header: "A guest is never in a group
--  room ... no room that can be orphaned by a guest leaving." That stops being
--  true the moment a guest can be in a room, so pm_guest_forget is rewritten
--  below to hold the invariant pm_group_leave already holds: a room nobody is
--  in is deleted, not left behind.
--
--  It was ALREADY not true. Two rooms in production carry messages and ZERO
--  members, so nobody, not even the account that made them, can open them,
--  post to them, or delete them (pm_group_delete needs an owner row). Section
--  4 sweeps them up under the rule pm_group_leave already applies.
--
--  APPLIED TO PRODUCTION 2026-09-10, in four migrations named
--  pm_reach_guests_1_predicates .. _4_guest_end_and_repair (the Supabase MCP;
--  `node scripts/db/apply_sql.mjs` is refused by the permission classifier
--  while auto mode is on, which is the documented trap in
--  [[pawa2-db-hardening-applied]]).
--
--  Verified after applying: both predicates carry the narrowed clause; all
--  three callers kept their app_is_guest() SENDER check and lost their
--  recipient-side is_guest filter; six functions, no overloads, all still
--  SECURITY DEFINER and still granted to authenticated; and the two orphaned
--  rooms came back with their creator as owner and every message openable by
--  them (8 of 8, and 2 of 2). Nothing was deleted.
--
--  Idempotent. Safe to re-apply.
--  Depends on: p_message.sql, p_message_groups.sql, p_message_audience.sql,
--              p_message_open.sql, p_message_guest_end.sql.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. The two predicates. A guest is a stranger, not an untouchable.
-- ---------------------------------------------------------------------------

create or replace function public.pm_may_cast_to(p_other text)
  returns boolean
  language sql
  stable security definer
  set search_path = public
as $fn$
  select case
    when coalesce(public.app_uid(), '') = '' then false
    when p_other is null or p_other = public.app_uid() then false
    -- A guest SENDING is still refused. A guest session is a browser tab: it
    -- may answer an agent (pm_start_direct has its own arm for that) and it
    -- may reach nobody new.
    when public.app_is_guest() then false
    -- Before the admin arm, deliberately. A block an admin could step over is
    -- a promise with an asterisk on it.
    when public.pm_blocked_between(public.app_uid(), p_other) then false
    -- A guest RECEIVING is refused as a stranger, which is what this clause
    -- was always for. An invited customer who accepted the link and talked to
    -- you is not a stranger, and refusing them made the invite feature
    -- incapable of ever producing a reachable person.
    when coalesce((select k.is_guest from public.pm_keys k where k.user_id = p_other), false)
      then public.pm_deals_with(p_other)
    when public.is_admin() then true
    else public.pm_deals_with(p_other)
  end;
$fn$;

create or replace function public.pm_may_room_with(p_other text)
  returns boolean
  language sql
  stable security definer
  set search_path = public
as $fn$
  select case
    when coalesce(public.app_uid(), '') = '' then false
    when p_other is null or p_other = public.app_uid() then false
    when public.app_is_guest() then false
    when public.pm_blocked_between(public.app_uid(), p_other) then false
    -- The shopfront arm below deliberately does NOT extend to guests: a guest
    -- cannot publish a listing at all (app_is_guest fences the catalogue), so
    -- for a guest "we deal with each other" is the only door, exactly as for
    -- an announcement.
    when coalesce((select k.is_guest from public.pm_keys k where k.user_id = p_other), false)
      then public.pm_deals_with(p_other)
    when public.is_admin() then true
    when public.pm_deals_with(p_other) then true
    else coalesce((select k.is_agent from public.pm_keys k where k.user_id = p_other), false)
         or exists (select 1 from public.pm_owner_listings o where o.user_id = p_other)
  end;
$fn$;

-- ---------------------------------------------------------------------------
-- 2. The three callers stop asking the question themselves.
--    Each of these bodies is its p_message_open.sql original with one join
--    condition removed; everything else is unchanged, deliberately.
-- ---------------------------------------------------------------------------

create or replace function public.pm_broadcast(
  p_title      text,
  p_region     text,
  p_iv         text,
  p_ciphertext text,
  p_keys       jsonb,
  p_thread     uuid default null
) returns uuid
  language plpgsql
  security definer
  set search_path = public
as $fn$
declare
  v_uid    text := public.app_uid();
  v_admin  boolean := public.is_admin();
  v_thread uuid;
  v_msg    uuid;
  v_ok     text[];
  v_cap    int;
  v_recent int;
begin
  if coalesce(v_uid, '') = '' then raise exception 'Sign in first'; end if;
  if public.app_is_guest() then
    raise exception 'A guest session cannot send an announcement. Sign in to send one.';
  end if;
  if not exists (select 1 from public.pm_keys where user_id = v_uid) then
    raise exception 'Set up P-Message on this device first';
  end if;
  if p_keys is null or jsonb_array_length(p_keys) = 0 then
    raise exception 'Nobody in that scope has set up P-Message yet';
  end if;
  if coalesce(p_iv, '') = '' or coalesce(p_ciphertext, '') = '' then
    raise exception 'Nothing to send';
  end if;
  if length(p_ciphertext) > public.pm_max_ciphertext() then
    raise exception 'That announcement is too long to send';
  end if;

  if not v_admin then
    select count(*) into v_recent
    from public.pm_threads t
    where t.created_by = v_uid and t.kind = 'broadcast'
      and t.created_at > now() - interval '1 day';
    if v_recent >= public.pm_casts_per_day() then
      raise exception 'You can send % announcements a day. Try again tomorrow.',
        public.pm_casts_per_day();
    end if;
  end if;

  -- Everybody named who holds a key, is not me, and whom this account may
  -- advertise to. The guest test that used to sit in this WHERE clause is
  -- gone: pm_may_cast_to answers it now, and answers it with the relationship
  -- taken into account instead of refusing every guest outright.
  select array_agg(distinct k->>'user_id') into v_ok
  from jsonb_array_elements(p_keys) k
  where (k->>'user_id') <> v_uid
    and exists (select 1 from public.pm_keys pk where pk.user_id = k->>'user_id')
    and public.pm_may_cast_to(k->>'user_id');

  if v_ok is null or array_length(v_ok, 1) is null then
    raise exception 'Nobody you already deal with is in that list. Write to somebody first, or send them an invite, and they can be announced to after that.';
  end if;

  if not v_admin then
    v_cap := public.pm_cast_max_open();
    if array_length(v_ok, 1) > v_cap then
      raise exception 'An announcement you send reaches at most % people.', v_cap;
    end if;
  end if;

  insert into public.pm_threads (id, kind, title, region, created_by)
  values (coalesce(p_thread, gen_random_uuid()), 'broadcast',
          coalesce(nullif(trim(coalesce(p_title, '')), ''), 'Announcement'),
          nullif(p_region, ''), v_uid)
  returning id into v_thread;

  insert into public.pm_members (thread_id, user_id, role)
  select v_thread, u, 'member' from unnest(v_ok) u
  on conflict do nothing;
  insert into public.pm_members (thread_id, user_id, role)
  values (v_thread, v_uid, 'owner')
  on conflict (thread_id, user_id) do update set role = 'owner';

  insert into public.pm_messages (thread_id, sender_id, iv, ciphertext)
  values (v_thread, v_uid, p_iv, p_ciphertext)
  returning id into v_msg;

  -- Unchanged, and load-bearing: membership is the filter, so a wrap for
  -- somebody the fence dropped simply never lands. The sender is a member
  -- (owner, just above), so the sender's own wrap lands here too — which is
  -- what lets an announcement be readable by the person who sent it.
  insert into public.pm_message_keys (message_id, user_id, epk, wrapped_key)
  select v_msg, k->>'user_id', k->>'epk', k->>'wrapped_key'
  from jsonb_array_elements(p_keys) k
  where exists (
    select 1 from public.pm_members m
    where m.thread_id = v_thread and m.user_id = k->>'user_id')
  on conflict (message_id, user_id) do nothing;

  return v_thread;
end $fn$;

create or replace function public.pm_group_create(
  p_title    text,
  p_category text,
  p_region   text,
  p_members  jsonb,
  p_thread   uuid default null
) returns uuid
  language plpgsql
  security definer
  set search_path = public
as $fn$
declare
  v_uid    text := public.app_uid();
  v_admin  boolean := public.is_admin();
  v_thread uuid;
  v_keyed  text[];
  v_ok     text[];
  v_cap    int;
  v_recent int;
begin
  if coalesce(v_uid, '') = '' then raise exception 'Sign in first'; end if;
  if public.app_is_guest() then
    raise exception 'A guest session cannot open a room. Sign in to open one.';
  end if;
  if p_members is null or jsonb_array_length(p_members) = 0 then
    raise exception 'Choose at least one person for the room';
  end if;
  if length(coalesce(p_title, '')) > 120 then
    raise exception 'That room name is too long';
  end if;

  if not exists (select 1 from public.pm_keys where user_id = v_uid) then
    raise exception 'Set up P-Message on this device before opening a room';
  end if;

  -- Everyone named who could actually be sealed to. Holding a key is the whole
  -- test now; whether that key belongs to a guest is pm_may_room_with's
  -- business, one step down.
  select array_agg(distinct m.uid) into v_keyed
  from (select jsonb_array_elements_text(p_members) as uid) m
  join public.pm_keys k on k.user_id = m.uid
  where m.uid <> v_uid;

  if v_keyed is null or array_length(v_keyed, 1) is null then
    raise exception 'None of those people have set up P-Message yet';
  end if;

  select array_agg(u) into v_ok
  from unnest(v_keyed) u
  where public.pm_may_room_with(u);

  if v_ok is null or array_length(v_ok, 1) is null then
    raise exception 'You can only open a room with people you already deal with, or who have listed something. Write to one of them first, or send them an invite.';
  end if;

  v_cap := case when v_admin then public.pm_group_max() else public.pm_group_max_open() end;
  if array_length(v_ok, 1) + 1 > v_cap then
    raise exception 'A room you open holds at most % people.', v_cap;
  end if;

  if not v_admin then
    select count(*) into v_recent
    from public.pm_threads t
    where t.created_by = v_uid and t.kind = 'group'
      and t.created_at > now() - interval '1 day';
    if v_recent >= public.pm_rooms_per_day() then
      raise exception 'You can open % rooms a day. Try again tomorrow.', public.pm_rooms_per_day();
    end if;
  end if;

  insert into public.pm_threads (id, kind, title, region, category, created_by)
  values (
    coalesce(p_thread, gen_random_uuid()),
    'group',
    coalesce(nullif(trim(coalesce(p_title, '')), ''), 'Group'),
    nullif(p_region, ''),
    nullif(p_category, ''),
    v_uid
  )
  returning id into v_thread;

  insert into public.pm_members (thread_id, user_id, role)
  select v_thread, u, 'member' from unnest(v_ok) u
  on conflict do nothing;

  insert into public.pm_members (thread_id, user_id, role)
  values (v_thread, v_uid, 'owner')
  on conflict (thread_id, user_id) do update set role = 'owner';

  return v_thread;
end $fn$;

create or replace function public.pm_group_add(p_thread uuid, p_members jsonb)
  returns integer
  language plpgsql
  security definer
  set search_path = public
as $fn$
declare
  v_uid   text := public.app_uid();
  v_kind  text;
  v_total int;
  v_added int;
  v_cap   int;
begin
  select kind into v_kind from public.pm_threads where id = p_thread;
  if v_kind is null then raise exception 'No such conversation'; end if;
  if v_kind <> 'group' then raise exception 'That conversation is not a group'; end if;

  if not (public.is_admin() or exists (
        select 1 from public.pm_members
        where thread_id = p_thread and user_id = v_uid and role = 'owner')) then
    raise exception 'Only the room owner can add people';
  end if;

  v_cap := case when public.is_admin() then public.pm_group_max()
                else public.pm_group_max_open() end;

  with incoming as (
    select distinct m.uid
    from (select jsonb_array_elements_text(p_members) as uid) m
    join public.pm_keys k on k.user_id = m.uid
    where public.pm_may_room_with(m.uid)
  )
  select count(*) into v_total
  from (
    select user_id from public.pm_members where thread_id = p_thread
    union
    select uid from incoming
  ) both_sides;

  if v_total > v_cap then
    raise exception 'A room holds at most % people.', v_cap;
  end if;

  with incoming as (
    select distinct m.uid
    from (select jsonb_array_elements_text(p_members) as uid) m
    join public.pm_keys k on k.user_id = m.uid
    where public.pm_may_room_with(m.uid)
  ), ins as (
    insert into public.pm_members (thread_id, user_id, role)
    select p_thread, uid, 'member' from incoming
    on conflict do nothing
    returning 1
  )
  select count(*)::int into v_added from ins;

  -- Adding someone does not expose old messages (their wraps do not exist),
  -- but it DOES mean the current sender keys were handed out to a smaller
  -- room. Bumping keeps one invariant instead of two.
  if v_added > 0 then
    update public.pm_threads set key_generation = key_generation + 1 where id = p_thread;
  end if;

  return v_added;
end $fn$;

-- ---------------------------------------------------------------------------
-- 3. Ending a guest session can now empty a room, so it must tidy up after
--    itself. This is pm_group_leave's rule, applied to the same event.
-- ---------------------------------------------------------------------------

create or replace function public.pm_guest_forget(p_wipe_messages boolean default false)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $fn$
declare
  v_uid     text := public.app_uid();
  v_threads int  := 0;
  v_msgs    int  := 0;
  v_rooms   int  := 0;
  v_left    uuid[] := '{}';
begin
  if v_uid is null then
    raise exception 'There is no session to end';
  end if;

  if not public.app_is_guest() then
    raise exception 'Only a guest session can be ended this way';
  end if;

  if coalesce(p_wipe_messages, false) then
    with gone as (
      update public.pm_messages m
         set deleted_at = now(),
             deleted_by = v_uid,
             ciphertext = '',
             iv         = ''
       where m.sender_id = v_uid
         and m.deleted_at is null
      returning m.id
    )
    select count(*) into v_msgs from gone;

    delete from public.pm_message_keys k
     using public.pm_messages m
     where k.message_id = m.id
       and m.sender_id = v_uid
       and m.deleted_at is not null;
  end if;

  -- Leave every conversation, keeping the thread ids in a local array. A temp
  -- table would have been the obvious shape and is the wrong one here: this
  -- function pins `search_path = public` (the hardening pass every SECURITY
  -- DEFINER in this schema went through), and pg_temp is exactly the schema
  -- that pinning exists to keep out of relation lookups.
  with departed as (
    delete from public.pm_members
     where user_id = v_uid
    returning thread_id
  )
  select coalesce(array_agg(distinct thread_id), '{}') into v_left from departed;

  v_threads := coalesce(array_length(v_left, 1), 0);

  -- A room the guest was the last member of is ciphertext no living key can
  -- open. pm_group_leave deletes such a room; before this file, ending a guest
  -- session did not, and the room survived with an empty roster: invisible in
  -- every inbox (pm_inbox joins pm_members), unopenable, and undeletable,
  -- because pm_group_delete asks for an owner row that no longer exists.
  with dead as (
    delete from public.pm_threads t
     where t.id = any (v_left)
       and t.kind in ('group', 'broadcast')
       and not exists (select 1 from public.pm_members m where m.thread_id = t.id)
    returning 1
  )
  select count(*) into v_rooms from dead;

  -- And stop being reachable.
  delete from public.pm_keys where user_id = v_uid;

  return jsonb_build_object('threads', v_threads, 'messages', v_msgs, 'rooms_closed', v_rooms);
end $fn$;

-- ---------------------------------------------------------------------------
-- 4. Give the already-orphaned rooms back to the person who made them.
--
--    Two rooms in production carry messages and no members at all. They are
--    unreachable by construction: pm_inbox is driven by pm_members, so an
--    empty room is in nobody's list; pm_thread_messages checks pm_is_member,
--    so its messages cannot be fetched; pm_group_delete asks for an owner row,
--    so it cannot even be closed.
--
--    The first instinct is to delete them, because that is what pm_group_leave
--    does to a room the last member walked out of. It is the wrong instinct
--    HERE, and the difference is worth stating: pm_group_leave deletes a room
--    whose messages nobody holds a key for. These messages have a key. Every
--    one of them was sent by the account that created the room and carries a
--    wrap addressed to that same account, which still exists and still has its
--    key published. Nothing is undecryptable; the only thing missing is one
--    row saying so.
--
--    So the repair is to write that row back. What was destroyed was
--    membership, not content, and restoring membership restores the room.
--
--    Only then, and only for a room whose creator is genuinely gone, does the
--    pm_group_leave rule apply and the thread go.
--
--    Direct threads are untouched throughout: they have no owner, and an empty
--    one is a different question with a different answer.
-- ---------------------------------------------------------------------------

insert into public.pm_members (thread_id, user_id, role)
select t.id, t.created_by, 'owner'
  from public.pm_threads t
 where t.kind in ('group', 'broadcast')
   and t.created_by is not null
   and exists (select 1 from public.pm_keys k where k.user_id = t.created_by)
   and not exists (select 1 from public.pm_members m where m.thread_id = t.id)
on conflict (thread_id, user_id) do update set role = 'owner';

delete from public.pm_threads t
 where t.kind in ('group', 'broadcast')
   and not exists (select 1 from public.pm_members m where m.thread_id = t.id);

commit;
