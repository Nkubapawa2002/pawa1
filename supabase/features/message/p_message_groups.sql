-- ============================================================================
-- p_message_groups.sql — agent group rooms ("meetings"), scoped by what an
-- agent deals in and where they work, with the same encryption as everything
-- else in P-Message.
-- ============================================================================
-- An admin opens a room -- "Dar es Salaam house agents", "Trucks, nationwide"
-- -- and every agent in that scope can talk to EACH OTHER in it. That is the
-- difference from pm_broadcast, which is one admin talking AT a region and
-- carries no reply path.
--
-- WHAT IS UNCHANGED, DELIBERATELY
-- The crypto. A group message is sealed exactly like a direct one: one random
-- AES-256-GCM content key, one body encryption, one ECDH+HKDF wrap per member.
-- No new primitive, no new format, no second code path to get wrong. The only
-- thing groups needed from the client was a way to learn every member's public
-- key, which is pm_thread_keys() below.
--
-- THREE THINGS THIS DESIGN DOES NOT DO, STATED SO NOBODY DISCOVERS THEM LATER
--  1. It does not hide metadata. Who is in a room, who sent a message, when,
--     and roughly how long it was, are all in the clear -- as they are for
--     direct threads. Bodies are unreadable; the shape of the conversation is
--     not. Nothing here is "untraceable" and it must never be described that
--     way in the UI.
--  2. A member added tomorrow cannot read what was said today. Wraps are made
--     per message, for the members who existed when it was sent, and there is
--     no re-wrapping. That is the honest behaviour of this scheme rather than
--     a limitation to apologise for -- but it does mean a room is not an
--     archive, and the UI should say so when someone joins.
--  3. It does not scale to a whole country in one room. Every message costs
--     the SENDER one ECDH per member, on their phone: ~60 members is about
--     half a second, 250 is a few seconds, 900 would be unusable. Hence
--     pm_group_max(). A national ANNOUNCEMENT is still pm_broadcast's job --
--     one sender, one time. A national free-for-all chat is not a meeting, and
--     making it one would need sender keys (a different protocol, with its own
--     trade-offs) rather than a bigger number here.
--
-- WHY CATEGORY IS DERIVED, NOT DECLARED
-- Neither agent_profiles nor pm_keys carries a category. Rather than add one
-- and ask every agent to maintain it (and then rank a stale answer), a room's
-- membership is derived from what an agent actually has listed: a house owner
-- is in "houses". It is always current, and it costs no data entry.
-- NOTE: day_jobs has no owner column at all -- a day job records company_name
-- and a phone, not an account -- so "jobs" is NOT an available category. It
-- cannot be added without first giving day_jobs an owner.
--
-- Idempotent. Safe to re-run. Depends on p_message.sql and p_message_guests.sql.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. A third kind of thread
-- ---------------------------------------------------------------------------
-- 'direct'    two people
-- 'broadcast' one admin -> many, no reply path
-- 'group'     many <-> many, inside a scope an admin chose
alter table public.pm_threads drop constraint if exists pm_threads_kind_check;
alter table public.pm_threads add constraint pm_threads_kind_check
  check (kind in ('direct', 'broadcast', 'group'));

-- What the room is FOR. Null category = every agent in the region regardless
-- of what they list; null region = the whole country. Both null is "everyone",
-- which is exactly the room most likely to hit the size cap.
alter table public.pm_threads add column if not exists category text;
alter table public.pm_threads drop constraint if exists pm_threads_category_check;
alter table public.pm_threads add constraint pm_threads_category_check
  check (category is null or category in ('houses', 'services', 'trucks'));

create index if not exists pm_threads_kind_idx on public.pm_threads (kind, last_at desc);

-- ---------------------------------------------------------------------------
-- 2. The size cap, in one place
-- ---------------------------------------------------------------------------
-- A function rather than a literal sprinkled through three RPCs, because when
-- this number changes it must change everywhere at once. The number is a
-- client-side cost, not a database one: see note 3 in the header.
create or replace function public.pm_group_max()
  returns int language sql immutable as $fn$ select 250 $fn$;

-- ---------------------------------------------------------------------------
-- 3. Who would be in the room
-- ---------------------------------------------------------------------------
-- Admin-only, and it returns public keys -- which are public by design -- and
-- never a phone number or an email. The admin seals nothing here; this is the
-- "who am I about to put in a room together" preview, and the same rows are
-- what pm_group_create() is then given.
create or replace function public.pm_group_candidates(
  p_category text default null,
  p_region   text default null
) returns table (
  user_id      text,
  public_key   text,
  display_name text,
  region       text,
  listings     int
)
  language sql
  stable
  security definer
  set search_path = public
as $fn$
  with owned as (
    select owner_user_id as uid, 'houses'   as cat from public.houses   where owner_user_id is not null
    union all
    select owner_user_id,        'services'      from public.services where owner_user_id is not null
    union all
    select owner_user_id,        'trucks'        from public.trucks   where owner_user_id is not null
  )
  select
    k.user_id,
    k.public_key,
    coalesce(k.display_name, ap.name),
    coalesce(k.region, ap.region),
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
        -- With a category: only people who actually list in it.
        when p_category is not null and p_category <> '' then
          exists (select 1 from owned o where o.uid = k.user_id and o.cat = p_category)
        -- Without one: anyone who is an agent or has listed anything at all.
        else k.is_agent or exists (select 1 from owned o where o.uid = k.user_id)
      end
    )
  order by coalesce(k.region, ap.region) nulls last, coalesce(k.display_name, ap.name) nulls last;
$fn$;

-- ---------------------------------------------------------------------------
-- 4. Every member's public key -- what makes a group sendable at all
-- ---------------------------------------------------------------------------
-- A direct thread has one other person, and the client already had their key
-- from the directory. A group has N, and they change. Without this the client
-- could read a room and never write to it.
--
-- Restricted to members of the room. The keys are individually public, but a
-- roster of who is in which meeting is not something to hand to anyone who
-- asks -- and pm_is_member() is SECURITY DEFINER precisely so this test does
-- not re-enter RLS.
create or replace function public.pm_thread_keys(p_thread uuid)
  returns table (
    user_id      text,
    public_key   text,
    display_name text,
    role         text,
    is_guest     boolean
  )
  language sql
  stable
  security definer
  set search_path = public
as $fn$
  select k.user_id, k.public_key, coalesce(k.display_name, ap.name), m.role,
         coalesce(k.is_guest, false)
  from public.pm_members m
  join public.pm_keys k on k.user_id = m.user_id
  left join public.agent_profiles ap on ap.user_id = m.user_id
  where m.thread_id = p_thread
    and public.pm_is_member(p_thread)
  order by (m.role = 'owner') desc, coalesce(k.display_name, ap.name) nulls last;
$fn$;

-- ---------------------------------------------------------------------------
-- 5. Opening a room
-- ---------------------------------------------------------------------------
-- Deliberately NOT bundled with a first message, unlike pm_broadcast. A
-- broadcast is one shot and the body must land with it; a room is a place, and
-- it can sit empty until someone speaks. Keeping creation free of ciphertext
-- means there is exactly one send path -- pm_send() -- for every kind of
-- thread, which is one fewer place for the crypto to diverge.
create or replace function public.pm_group_create(
  p_title    text,
  p_category text,
  p_region   text,
  p_members  jsonb,             -- ["user_id", ...] from pm_group_candidates()
  p_thread   uuid default null  -- caller may choose the id (see pm_broadcast)
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
    raise exception 'Nobody in that scope has set up P-Message yet';
  end if;

  -- The opener joins as owner, so they must have a key of their own FIRST.
  -- Without this check a room could be opened by someone with nothing
  -- published: they would sit in it as owner, be skipped by every seal (there
  -- is no key to wrap to), and read nothing — a silent, permanent exclusion
  -- that looks like a delivery bug. Better to say so before the room exists.
  if not exists (select 1 from public.pm_keys where user_id = v_uid) then
    raise exception 'Set up P-Message on this device before opening a room';
  end if;

  -- Count the DISTINCT real members we are about to add, not the array length:
  -- a caller that repeats a user id must not be able to talk its way past the
  -- cap, and must not create duplicate rows either.
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

  -- The admin is in the room they opened, as owner.
  insert into public.pm_members (thread_id, user_id, role)
  values (v_thread, v_uid, 'owner')
  on conflict (thread_id, user_id) do update set role = 'owner';

  return v_thread;
end $fn$;

-- ---------------------------------------------------------------------------
-- 6. Adding people later
-- ---------------------------------------------------------------------------
-- Returns how many were actually added, so the caller can say "4 added, 2 were
-- already in" instead of guessing. Note again: they will see what is said from
-- now on, and nothing that was said before.
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
begin
  select kind into v_kind from public.pm_threads where id = p_thread;
  if v_kind is null then raise exception 'No such conversation'; end if;
  if v_kind <> 'group' then raise exception 'That conversation is not a group'; end if;

  -- The admin, or the owner of this particular room.
  if not (public.is_admin() or exists (
        select 1 from public.pm_members
        where thread_id = p_thread and user_id = v_uid and role = 'owner')) then
    raise exception 'Only the room owner can add people';
  end if;

  with incoming as (
    select distinct m.uid
    from (select jsonb_array_elements_text(p_members) as uid) m
    join public.pm_keys k on k.user_id = m.uid and not coalesce(k.is_guest, false)
  )
  select count(*) into v_total
  from (
    select user_id from public.pm_members where thread_id = p_thread
    union
    select uid from incoming
  ) both_sides;

  if v_total > public.pm_group_max() then
    raise exception 'A room holds at most % people.', public.pm_group_max();
  end if;

  with incoming as (
    select distinct m.uid
    from (select jsonb_array_elements_text(p_members) as uid) m
    join public.pm_keys k on k.user_id = m.uid and not coalesce(k.is_guest, false)
  ), ins as (
    insert into public.pm_members (thread_id, user_id, role)
    select p_thread, uid, 'member' from incoming
    on conflict do nothing
    returning 1
  )
  select count(*)::int into v_added from ins;

  return v_added;
end $fn$;

-- ---------------------------------------------------------------------------
-- 7. Leaving, and removing
-- ---------------------------------------------------------------------------
-- Anyone can leave a room. Nobody can be made to stay in one, and an owner
-- leaving does not dissolve it.
create or replace function public.pm_group_leave(p_thread uuid)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $fn$
declare v_uid text := public.app_uid();
begin
  if v_uid is null then raise exception 'Sign in first'; end if;
  delete from public.pm_members
  where thread_id = p_thread and user_id = v_uid
    and exists (select 1 from public.pm_threads t where t.id = p_thread and t.kind = 'group');
end $fn$;

create or replace function public.pm_group_remove(p_thread uuid, p_user text)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $fn$
declare v_uid text := public.app_uid();
begin
  if not (public.is_admin() or exists (
        select 1 from public.pm_members
        where thread_id = p_thread and user_id = v_uid and role = 'owner')) then
    raise exception 'Only the room owner can remove people';
  end if;
  -- Removing someone stops them receiving what is sent from now on. It cannot
  -- claw back what they already hold: their wraps for past messages are on
  -- their device, decrypted. Saying otherwise in the UI would be a lie.
  delete from public.pm_members
  where thread_id = p_thread and user_id = p_user and role <> 'owner';
end $fn$;

-- ---------------------------------------------------------------------------
-- 8. Grants
-- ---------------------------------------------------------------------------
grant execute on function public.pm_group_max()                          to anon, authenticated;
grant execute on function public.pm_group_candidates(text, text)         to anon, authenticated;
grant execute on function public.pm_thread_keys(uuid)                    to anon, authenticated;
grant execute on function public.pm_group_create(text, text, text, jsonb, uuid) to anon, authenticated;
grant execute on function public.pm_group_add(uuid, jsonb)               to anon, authenticated;
grant execute on function public.pm_group_leave(uuid)                    to anon, authenticated;
grant execute on function public.pm_group_remove(uuid, text)             to anon, authenticated;

commit;

-- ============================================================================
-- The client flow for a room:
--   admin: pm_group_candidates(category, region)   -> review who is in scope
--          pm_group_create(title, cat, region, ids) -> thread id
--   member: pm_thread_keys(thread)                 -> every member's public key
--           PMCrypto.seal({threadId, senderId, recipients, plaintext})
--           pm_send(thread, iv, ciphertext, keys)  -- unchanged, already works
--           pm_thread_messages(thread) -> PMCrypto.open(row, me)
-- The sender MUST include themselves in recipients or they cannot read their
-- own message back -- pm_thread_keys() returns them, so this is automatic.
-- ============================================================================
