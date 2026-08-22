-- ============================================================================
-- p_message_rooms.sql — a room you can see into, and an agent you can tell
-- apart from another agent.
-- ============================================================================
-- Three things the screen could not do, all of them because the database was
-- not returning enough to do them with, plus one plain bug in reading.
--
-- 1. WHERE SOMEBODY WORKS, WHEREVER THEY APPEAR.
--    `area_of_operations` is the single fact that makes one agent more use
--    than another: a person in Mwanza needs somebody who works in Mwanza, and
--    a name on its own answers nothing. pm_agent_finder() returns it, so the
--    Agents list can show it. Nothing else did. Open a conversation and the
--    header knew only a name; open a room and the member list knew only a
--    name; look at the admin's roster preview before opening a room and it
--    knew only a name. Same fact, three places it was missing.
--
--    So pm_peer(), pm_thread_keys() and pm_group_candidates() all return the
--    working identity now — area, ward, district, region — and never the
--    phone, exactly as pm_directory has always done it. agent_profiles is not
--    world-readable and these are SECURITY DEFINER views over it; that is the
--    same privacy model, not a new one.
--
-- 2. A ROOM WITH NO ROSTER IS NOT A ROOM.
--    Rooms shipped with pm_group_add / _remove / _leave and no way to call
--    any of them, because nothing could answer "who is in here?" in a form
--    the screen could draw. pm_thread_keys() was that answer all along — it
--    is what the client already fetches to seal a message — but it returned
--    five columns and none of them said when somebody joined or where they
--    work. It does now, and the member sheet is built on it rather than on a
--    second query that could disagree with the one the crypto uses.
--
-- 3. AN ADMIN OPENING A ROOM SHOULD CHOOSE WHO IS IN IT.
--    pm_group_create() has always taken an explicit member list. The screen
--    handed it every candidate the scope returned, so "scope" and "membership"
--    were the same thing and an admin who wanted eleven of the fourteen people
--    in Mwanza had no way to say so. The candidate list now carries enough to
--    pick from — who they are, where they work, how much they list — and the
--    array is what it always was. No signature changes here for that; the fix
--    is that the data finally supports the choice.
--
-- AND THE BUG
--
--    pm_thread_messages ends `order by msg.sent_at limit 500`. Ascending order
--    with a limit returns the OLDEST five hundred messages, forever. A busy
--    room reaches five hundred and then never shows another new message to
--    anybody — the conversation freezes at its own beginning, and every
--    message sent after that is stored, delivered, decryptable and invisible.
--    The page of messages a chat wants is the NEWEST n, shown oldest-first.
--
-- Idempotent. Safe to re-run. Depends on p_message.sql, _guests, _groups,
-- _sender_keys, _trust and _security.
--
--   usage:  node scripts/db/apply_sql.mjs supabase/features/message/p_message_rooms.sql
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Reading a thread — the newest page, not the oldest
-- ---------------------------------------------------------------------------
-- The subquery takes the last n by sent_at DESC; the outer select puts them
-- back in reading order. Doing it in one statement with a single ORDER BY is
-- what produced the bug: a limit has to be applied to the end you want to
-- keep, and a conversation wants the end it is still being written at.
drop function if exists public.pm_thread_messages(uuid, int);
create or replace function public.pm_thread_messages(
  p_thread uuid,
  p_limit  int default 100
) returns table (
  id          uuid,
  thread_id   uuid,
  sender_id   text,
  sender_name text,
  sender_guest boolean,
  alg         text,
  iv          text,
  ciphertext  text,
  epk         text,
  wrapped_key text,
  generation  int,
  seq         int,
  sent_at     timestamptz
)
  language sql
  stable
  security definer
  set search_path = public
as $fn$
  with page as (
    select
      msg.id, msg.thread_id, msg.sender_id,
      coalesce(k.display_name, ap.name) as sender_name,
      -- A room is the one place where the name beside a message is chosen by
      -- the person who chose it. Saying which of those people never proved
      -- who they are is not decoration; it is the difference between "the
      -- agent said so" and "somebody calling themselves that said so".
      coalesce(k.is_guest, false)       as sender_guest,
      msg.alg, msg.iv, msg.ciphertext, mk.epk, mk.wrapped_key,
      msg.generation, msg.seq, msg.sent_at
    from public.pm_messages msg
    left join public.pm_message_keys mk
      on mk.message_id = msg.id and mk.user_id = public.app_uid()
    left join public.pm_keys k on k.user_id = msg.sender_id
    left join public.agent_profiles ap on ap.user_id = msg.sender_id
    where msg.thread_id = p_thread
      and exists (
        select 1 from public.pm_members m
        where m.thread_id = p_thread and m.user_id = public.app_uid()
      )
      -- An ordinary message with no wrap for me is still not mine to see:
      -- that is what keeps a late joiner out of a room's history. A
      -- sender-key message carries no wrap by design, so it is judged by
      -- membership alone.
      and (msg.generation is not null or mk.wrapped_key is not null)
    order by msg.sent_at desc
    limit greatest(1, least(coalesce(p_limit, 100), 500))
  )
  select * from page order by sent_at;
$fn$;

-- ---------------------------------------------------------------------------
-- 2. The roster — who is in this room, and where do they work
-- ---------------------------------------------------------------------------
-- Still restricted to members, still the same query the client seals against.
-- The extra columns are the working identity and nothing else: no phone, no
-- email, exactly what pm_directory decided years of arguments ago.
drop function if exists public.pm_thread_keys(uuid);
create or replace function public.pm_thread_keys(p_thread uuid)
  returns table (
    user_id      text,
    public_key   text,
    display_name text,
    role         text,
    is_guest     boolean,
    is_agent     boolean,
    region       text,
    area         text,
    area_kind    text,
    district     text,
    ward         text,
    joined_at    timestamptz
  )
  language sql
  stable
  security definer
  set search_path = public
as $fn$
  select
    k.user_id, k.public_key, coalesce(k.display_name, ap.name), m.role,
    coalesce(k.is_guest, false), coalesce(k.is_agent, false),
    coalesce(k.region, ap.region),
    ap.area_of_operations, ap.area_kind, ap.district, ap.ward,
    m.joined_at
  from public.pm_members m
  join public.pm_keys k on k.user_id = m.user_id
  left join public.agent_profiles ap on ap.user_id = m.user_id
  where m.thread_id = p_thread
    and public.pm_is_member(p_thread)
  order by (m.role = 'owner') desc, coalesce(k.display_name, ap.name) nulls last;
$fn$;

-- How many people are in a thread, without dragging the whole roster back for
-- a number. The thread list wants this per row and the roster call is far too
-- heavy to make once per line.
create or replace function public.pm_thread_size(p_thread uuid)
  returns int
  language sql
  stable
  security definer
  set search_path = public
as $fn$
  select case when public.pm_is_member(p_thread)
    then (select count(*)::int from public.pm_members where thread_id = p_thread)
    else 0 end;
$fn$;

-- ---------------------------------------------------------------------------
-- 3. The person on the other side — with where they work
-- ---------------------------------------------------------------------------
-- Same membership fence, same "derived on the device" rule for the safety
-- number: public_key is what the client hashes, and `fingerprint` stays a
-- tamper signal that nothing is decided by.
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
    ward         text
  )
  language sql
  stable
  security definer
  set search_path = public
as $fn$
  select k.user_id, coalesce(k.display_name, ap.name), k.public_key, k.fingerprint,
         k.is_agent, k.is_guest, coalesce(k.region, ap.region),
         ap.area_of_operations, ap.area_kind, ap.district, ap.ward
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

-- ---------------------------------------------------------------------------
-- 4. Candidates for a room — enough to choose from, not just to count
-- ---------------------------------------------------------------------------
-- The listing counts are split by category rather than summed, for the same
-- reason pm_agent_finder splits them: "eleven listings" and "eleven trucks"
-- are different claims about a person, and an admin picking who belongs in a
-- truckers' room needs the second one.
--
-- SUPERSEDED by p_message_jobs.sql, which adds n_jobs and replaces the inline
-- `owned` union below with a read of pm_owner_listings -- two definitions of
-- "what does this person own" is one too many, and this was the second.
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
  listings     int
)
  language sql
  stable
  security definer
  set search_path = public
as $fn$
  with owned as (
    select owner_user_id as uid, 'houses'::text as cat from public.houses   where owner_user_id is not null
    union all
    select owner_user_id, 'services'                   from public.services where owner_user_id is not null
    union all
    select owner_user_id, 'trucks'                     from public.trucks   where owner_user_id is not null
  )
  select
    k.user_id,
    k.public_key,
    coalesce(k.display_name, ap.name),
    coalesce(k.region, ap.region),
    ap.area_of_operations, ap.district, ap.ward,
    coalesce(k.is_agent, false),
    (select count(*)::int from owned o where o.uid = k.user_id and o.cat = 'houses'),
    (select count(*)::int from owned o where o.uid = k.user_id and o.cat = 'services'),
    (select count(*)::int from owned o where o.uid = k.user_id and o.cat = 'trucks'),
    (select count(*)::int from owned o
      where o.uid = k.user_id
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
          exists (select 1 from owned o where o.uid = k.user_id and o.cat = p_category)
        else k.is_agent or exists (select 1 from owned o where o.uid = k.user_id)
      end
    )
  order by coalesce(k.region, ap.region) nulls last, coalesce(k.display_name, ap.name) nulls last;
$fn$;

-- ---------------------------------------------------------------------------
-- 5. Opening a room — the member list is the membership
-- ---------------------------------------------------------------------------
-- Unchanged in every respect except two: the title is bounded, and the
-- explicit list is now the point rather than a formality. Everything the
-- earlier version checked, it still checks — admin only, the opener must hold
-- a key, guests are dropped, duplicates counted once, the cap enforced on the
-- DISTINCT count.
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
  v_thread uuid;
  v_n      int;
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  if p_members is null or jsonb_array_length(p_members) = 0 then
    raise exception 'Choose at least one person for the room';
  end if;
  if length(coalesce(p_title, '')) > 120 then
    raise exception 'That room name is too long';
  end if;

  if not exists (select 1 from public.pm_keys where user_id = v_uid) then
    raise exception 'Set up P-Message on this device before opening a room';
  end if;

  select count(distinct m.uid) into v_n
  from (select jsonb_array_elements_text(p_members) as uid) m
  join public.pm_keys k on k.user_id = m.uid and not coalesce(k.is_guest, false);

  if v_n = 0 then
    raise exception 'None of those people have set up P-Message yet';
  end if;
  if v_n > public.pm_group_max() then
    raise exception 'A room holds at most % people. Narrow it by region or category.',
      public.pm_group_max();
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
  select distinct v_thread, m.uid, 'member'
  from (select jsonb_array_elements_text(p_members) as uid) m
  join public.pm_keys k on k.user_id = m.uid and not coalesce(k.is_guest, false)
  on conflict do nothing;

  insert into public.pm_members (thread_id, user_id, role)
  values (v_thread, v_uid, 'owner')
  on conflict (thread_id, user_id) do update set role = 'owner';

  return v_thread;
end $fn$;

-- ---------------------------------------------------------------------------
-- 6. Removing somebody — and the owner who is the only one left
-- ---------------------------------------------------------------------------
-- pm_group_remove refuses to delete a row whose role is 'owner', which is
-- right (an owner should not be evictable by a co-owner) and was also the
-- second half of the room-takeover bug: a member who had promoted themselves
-- could not be demoted back. With `pm_members self update` gone, the only
-- owner is the admin who opened the room, and this rule costs nothing.
--
-- Redefined here only to say so in one place; the body is unchanged from
-- p_message_sender_keys.sql, generation bump and all.
create or replace function public.pm_group_remove(p_thread uuid, p_user text)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $fn$
declare
  v_uid  text := public.app_uid();
  v_gone int;
begin
  if not (public.is_admin() or exists (
        select 1 from public.pm_members
        where thread_id = p_thread and user_id = v_uid and role = 'owner')) then
    raise exception 'Only the room owner can remove people';
  end if;

  with del as (
    delete from public.pm_members
    where thread_id = p_thread and user_id = p_user and role <> 'owner'
    returning 1
  )
  select count(*)::int into v_gone from del;

  -- Removing someone who keeps a live sender key removes nothing at all.
  if v_gone > 0 then
    update public.pm_threads set key_generation = key_generation + 1 where id = p_thread;
    delete from public.pm_sender_keys where thread_id = p_thread and recipient_id = p_user;
  end if;
end $fn$;

-- ---------------------------------------------------------------------------
-- 7. Grants
-- ---------------------------------------------------------------------------
grant execute on function public.pm_thread_messages(uuid, int)   to anon, authenticated;
grant execute on function public.pm_thread_keys(uuid)            to anon, authenticated;
grant execute on function public.pm_thread_size(uuid)            to anon, authenticated;
grant execute on function public.pm_peer(text)                   to anon, authenticated;
grant execute on function public.pm_group_candidates(text, text) to anon, authenticated;
grant execute on function public.pm_group_create(text, text, text, jsonb, uuid) to anon, authenticated;
grant execute on function public.pm_group_remove(uuid, text)     to anon, authenticated;

commit;
