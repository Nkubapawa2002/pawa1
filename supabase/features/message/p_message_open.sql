-- ============================================================================
--  p_message_open.sql — a room and an announcement stop being admin-only.
-- ============================================================================
--  Four functions, one change each, and the change is the same change: the
--  line `if not public.is_admin() then raise exception 'Admins only'` comes
--  out, and the fences from p_message_audience.sql go in.
--
--  Deleting those lines on their own would have been the wrong half of the
--  work. What they were doing, crudely, was keeping strangers out of each
--  other's inboxes; ADMIN_EMAILS holds one address, so in practice nobody
--  could open a room and nobody could announce anything. The fences are the
--  replacement, and they are per-recipient rather than per-sender:
--
--    pm_group_create   every member must pass pm_may_room_with()
--    pm_group_add      the same, or room creation is fenced and room GROWTH
--                      is not, which is the same hole one call later
--    pm_broadcast      every recipient must pass pm_may_cast_to()
--    pm_start_direct   a block stops a NEW conversation
--
--  NOTHING IS DROPPED. All four keep their exact signature and return type,
--  so these are plain `create or replace` and there is never a window with no
--  function. No defaulted parameter is added anywhere either: that would leave
--  a second overload PostgREST refuses to choose between, and there is no need
--  for one because the member array already carries everything.
--
--  PEOPLE WHO DO NOT PASS ARE DROPPED, NOT RAISED ON.
--  pm_group_create has always silently dropped members with no key
--  (p_message_rooms.sql). Naming which of twelve ids was refused would be a
--  "that person blocked you" oracle, and the screen already knows the answer:
--  the picker asks pm_audience_check() before it draws a row, so the only way
--  to reach this backstop is to bypass the screen. What the client reports
--  afterwards is pm_thread_size(), the truth, rather than the length of the
--  array it sent.
--
--  TWO COUNTS, NOT ONE, on the way in. "Nobody there has P-Message" and "you
--  have not dealt with any of them" are different problems with different ways
--  out, and one sentence covering both is the sort of vague error this feature
--  avoids everywhere else.
--
--  A GUEST OPENS NOTHING. pm_broadcast never checked: guests were kept out
--  only because the client happened to call pm_recipients, which filters them.
--  Once the client stops being the only filter that stops being true, so both
--  the sender and every recipient are now checked in the function.
--
--  THE CEILINGS ARE SPLIT, NOT LOWERED. pm_group_max() stays 1000 and the
--  national announcement stays uncapped for an admin. Everybody else gets
--  pm_group_max_open() and pm_cast_max_open(), plus a rolling-day limit on how
--  many rooms and announcements they may start. All four are one-line
--  immutable functions, so throttling in an emergency is one statement and no
--  deploy.
--
--  Idempotent. Safe to re-run. Depends on p_message.sql, _guests, _groups,
--  _sender_keys, _security, _rooms, _delete, _announce and _audience.
--  Run it AFTER p_message_audience.sql: all four call functions defined there.
--
--    usage:  node scripts/db/apply_sql.mjs supabase/features/message/p_message_open.sql
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 0. It cannot run before the fences exist
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.pm_may_room_with(text)') is null
     or to_regprocedure('public.pm_may_cast_to(text)') is null then
    raise exception 'Apply supabase/features/message/p_message_audience.sql first';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Opening a room
-- ---------------------------------------------------------------------------
-- Generated from the deployed definition. Everything it checked, it still
-- checks; the admin test is replaced by a per-member test, and the member list
-- is resolved ONCE into an array rather than re-derived for the count and
-- again for the insert, so the room that is created cannot differ from the
-- room that was counted.
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

  -- Everyone named who could actually be sealed to.
  select array_agg(distinct m.uid) into v_keyed
  from (select jsonb_array_elements_text(p_members) as uid) m
  join public.pm_keys k on k.user_id = m.uid and not coalesce(k.is_guest, false)
  where m.uid <> v_uid;

  if v_keyed is null or array_length(v_keyed, 1) is null then
    raise exception 'None of those people have set up P-Message yet';
  end if;

  -- Of those, everyone this account may gather.
  select array_agg(u) into v_ok
  from unnest(v_keyed) u
  where public.pm_may_room_with(u);

  if v_ok is null or array_length(v_ok, 1) is null then
    raise exception 'You can only open a room with people you already deal with, or who have listed something. Write to one of them first.';
  end if;

  v_cap := case when v_admin then public.pm_group_max() else public.pm_group_max_open() end;
  -- The cap counts the room, so the owner is in it.
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

-- ---------------------------------------------------------------------------
-- 2. Growing a room
-- ---------------------------------------------------------------------------
-- Same body as the deployed one except that `incoming` now carries the reach
-- test, and the cap is the caller's rather than always the admin's. Without
-- this, opening a room is fenced and adding to it is not, which closes nothing
-- at all: an owner could open a room of one and then add five hundred.
create or replace function public.pm_group_add(p_thread uuid, p_members jsonb)
  returns int
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
    join public.pm_keys k on k.user_id = m.uid and not coalesce(k.is_guest, false)
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
    join public.pm_keys k on k.user_id = m.uid and not coalesce(k.is_guest, false)
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
  -- room. Bumping keeps one invariant instead of two: the generation always
  -- matches the membership it was distributed to.
  if v_added > 0 then
    update public.pm_threads set key_generation = key_generation + 1 where id = p_thread;
  end if;

  return v_added;
end $fn$;

-- ---------------------------------------------------------------------------
-- 3. The announcement
-- ---------------------------------------------------------------------------
-- The wrap insert at the end is UNCHANGED and that is the property that makes
-- dropping people safe: it already filters on pm_members, so a recipient who
-- did not survive the fence never becomes a member and their wrapped key is
-- discarded on the way in. One filter, applied once, fences both inserts.
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

  -- Everybody named who holds a key, is not a guest, is not me, and whom this
  -- account may advertise to.
  select array_agg(distinct k->>'user_id') into v_ok
  from jsonb_array_elements(p_keys) k
  where (k->>'user_id') <> v_uid
    and exists (select 1 from public.pm_keys pk
                 where pk.user_id = k->>'user_id'
                   and not coalesce(pk.is_guest, false))
    and public.pm_may_cast_to(k->>'user_id');

  if v_ok is null or array_length(v_ok, 1) is null then
    raise exception 'Nobody you already deal with is in that list. Write to somebody first, and they can be announced to after that.';
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
  -- somebody the fence dropped simply never lands.
  insert into public.pm_message_keys (message_id, user_id, epk, wrapped_key)
  select v_msg, k->>'user_id', k->>'epk', k->>'wrapped_key'
  from jsonb_array_elements(p_keys) k
  where exists (
    select 1 from public.pm_members m
    where m.thread_id = v_thread and m.user_id = k->>'user_id')
  on conflict (message_id, user_id) do nothing;

  return v_thread;
end $fn$;

-- ---------------------------------------------------------------------------
-- 4. A first conversation
-- ---------------------------------------------------------------------------
-- One clause added, and WHERE it is added is the whole of it. The idempotent
-- lookup runs first, so re-opening a conversation that predates a block still
-- returns it: the block stops new contact, and taking away a thread somebody
-- already has is a different act with a different button. Putting the check
-- above the lookup would also have made this function a probe -- ask about a
-- stranger, get one error; ask about somebody who blocked you, get another.
create or replace function public.pm_start_direct(p_other text)
  returns uuid
  language plpgsql
  security definer
  set search_path = public
as $fn$
declare
  v_uid    text := public.app_uid();
  v_guest  boolean := public.app_is_guest();
  v_id     uuid;
  v_recent int;
begin
  if v_uid is null then raise exception 'Sign in first'; end if;
  if p_other is null or p_other = v_uid then raise exception 'Pick someone else'; end if;
  if not exists (select 1 from public.pm_keys where user_id = p_other) then
    raise exception 'That person has not set up P-Message yet';
  end if;

  -- The idempotent lookup FIRST, so re-opening an existing conversation never
  -- counts against a limit. Tapping somebody you already talk to is not the
  -- behaviour either limit is aimed at, and charging for it would lock people
  -- out of their own inbox.
  select t.id into v_id
  from public.pm_threads t
  where t.kind = 'direct'
    and exists (select 1 from public.pm_members m where m.thread_id = t.id and m.user_id = v_uid)
    and exists (select 1 from public.pm_members m where m.thread_id = t.id and m.user_id = p_other)
    and (select count(*) from public.pm_members m where m.thread_id = t.id) = 2
  limit 1;
  if v_id is not null then return v_id; end if;

  -- The wording names no direction, because which of the two pressed it is
  -- not a fact either side needs and telling one of them invites the reply.
  if public.pm_blocked_between(v_uid, p_other) then
    raise exception 'You cannot start a conversation with that person.';
  end if;

  if v_guest then
    if not exists (select 1 from public.pm_keys where user_id = p_other and is_agent) then
      raise exception 'Guests can only message agents. Sign in to message anyone.';
    end if;
  end if;

  select count(*) into v_recent
  from public.pm_threads t
  where t.created_by = v_uid and t.created_at > now() - interval '1 hour';

  if v_guest and v_recent >= 5 then
    raise exception 'Too many new conversations in one hour. Try again later, or sign in.';
  end if;
  if v_recent >= public.pm_max_threads_per_hour() then
    raise exception 'Too many new conversations in one hour. Try again later.';
  end if;

  insert into public.pm_threads (kind, created_by) values ('direct', v_uid) returning id into v_id;
  insert into public.pm_members (thread_id, user_id, role) values
    (v_id, v_uid, 'owner'), (v_id, p_other, 'member');
  return v_id;
end $fn$;

-- ---------------------------------------------------------------------------
-- 5. Grants
-- ---------------------------------------------------------------------------
-- Unchanged from what these four already had. `create or replace` keeps the
-- existing grants, so these lines are here to be read rather than to change
-- anything, and to keep the file re-runnable on a fresh database.
grant execute on function public.pm_group_create(text, text, text, jsonb, uuid) to anon, authenticated;
grant execute on function public.pm_group_add(uuid, jsonb)                      to anon, authenticated;
grant execute on function public.pm_broadcast(text, text, text, text, jsonb, uuid) to anon, authenticated;
grant execute on function public.pm_start_direct(text)                          to anon, authenticated;

commit;
