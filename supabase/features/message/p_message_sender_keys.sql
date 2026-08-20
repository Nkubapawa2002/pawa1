-- ============================================================================
-- p_message_sender_keys.sql — the storage side of sender keys, and the one
-- rule that makes them safe.
-- ============================================================================
-- pm_send() costs the SENDER one ECDH per member per message. Measured: a
-- single message to 300 people is ~300ms on a laptop, several seconds on the
-- phones this is actually for. That is why pm_group_max() was 250.
--
-- A sender key is handed out once (N wraps, paid once) and every message after
-- it is a single AES-GCM encryption. Same measurement, same 300 people: ten
-- messages in 3ms.
--
-- THE RULE, AND WHY IT LIVES HERE INSTEAD OF IN THE CLIENT
-- Anyone holding a sender key reads everything sent under it. So when the
-- membership changes the key MUST be replaced, or a person removed from a room
-- keeps reading it. Forgetting is the silent failure of the whole design: the
-- room goes on working perfectly for everybody, including the person who was
-- just removed.
--
-- So the generation counter is a column on the thread, not a number the client
-- keeps. pm_group_add / _remove / _leave bump it, and pm_send_sk() REFUSES a
-- message sealed under a generation older than the thread's. A client that
-- forgets to rotate gets an error; it does not get a silent leak. That refusal
-- is the single most important line in this file.
--
-- WHAT IT STILL DOES NOT DO, unchanged from the rest of P-Message:
--  · Rotation is forward-looking. Someone removed keeps whatever they already
--    received; nothing can reach onto their device and take it back.
--  · Metadata stays in the clear.
--  · This is not weaker than seal(): that has no forward secrecy either, since
--    a stolen device key opens every wrap ever made to it. It is the same
--    promise at a size that works.
--
-- Idempotent. Safe to re-run. Depends on p_message.sql and p_message_groups.sql.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. The thread's generation
-- ---------------------------------------------------------------------------
alter table public.pm_threads add column if not exists key_generation int not null default 0;

-- ---------------------------------------------------------------------------
-- 2. Where a distributed sender key lives
-- ---------------------------------------------------------------------------
create table if not exists public.pm_sender_keys (
  thread_id    uuid not null references public.pm_threads(id) on delete cascade,
  sender_id    text not null,
  generation   int  not null,
  recipient_id text not null,
  epk          text not null,
  wrapped_key  text not null,
  created_at   timestamptz not null default now(),
  primary key (thread_id, sender_id, generation, recipient_id)
);

create index if not exists pm_sender_keys_for_me_idx
  on public.pm_sender_keys (recipient_id, thread_id);

alter table public.pm_sender_keys enable row level security;

drop policy if exists "pm_sender_keys mine" on public.pm_sender_keys;

-- The same posture as pm_message_keys: you can fetch YOUR wrap and nobody
-- else's. Another member's wrap is useless to you — it is sealed to their
-- private key — but there is no reason to hand it over.
create policy "pm_sender_keys mine" on public.pm_sender_keys for select
  using (recipient_id = (select public.app_uid()));

-- ---------------------------------------------------------------------------
-- 3. Messages carry which key opened them
-- ---------------------------------------------------------------------------
-- Both nullable: a null generation means the row predates this file and is an
-- ordinary per-recipient-wrapped message. The client picks its open() path off
-- these, so old messages keep working untouched.
alter table public.pm_messages add column if not exists generation int;
alter table public.pm_messages add column if not exists seq int;

-- ---------------------------------------------------------------------------
-- 4. Handing the key out
-- ---------------------------------------------------------------------------
create or replace function public.pm_sender_key_put(
  p_thread     uuid,
  p_generation int,
  p_keys       jsonb          -- [{ user_id, epk, wrapped_key }]
) returns int
  language plpgsql
  security definer
  set search_path = public
as $fn$
declare
  v_uid text := public.app_uid();
  v_gen int;
  v_n   int;
begin
  if v_uid is null then raise exception 'Sign in first'; end if;
  if not exists (select 1 from public.pm_members where thread_id = p_thread and user_id = v_uid) then
    raise exception 'You are not in that conversation';
  end if;
  if p_keys is null or jsonb_array_length(p_keys) = 0 then
    raise exception 'A sender key must be wrapped for at least one member';
  end if;

  select key_generation into v_gen from public.pm_threads where id = p_thread;
  if p_generation < v_gen then
    raise exception 'That generation is stale — the room has changed since. Re-wrap at generation %', v_gen;
  end if;

  -- Only ever to people actually in the room. A caller that includes an
  -- outsider is quietly ignoring them rather than being trusted.
  with ins as (
    insert into public.pm_sender_keys (thread_id, sender_id, generation, recipient_id, epk, wrapped_key)
    select p_thread, v_uid, p_generation, k->>'user_id', k->>'epk', k->>'wrapped_key'
    from jsonb_array_elements(p_keys) k
    where exists (
      select 1 from public.pm_members m
      where m.thread_id = p_thread and m.user_id = k->>'user_id')
    on conflict (thread_id, sender_id, generation, recipient_id) do nothing
    returning 1
  )
  select count(*)::int into v_n from ins;

  return v_n;
end $fn$;

-- ---------------------------------------------------------------------------
-- 5. Collecting the keys addressed to me
-- ---------------------------------------------------------------------------
-- Every sender's key for this room in one call. A room of 200 chatty people
-- has 200 sender keys and fetching them one at a time is 200 requests.
create or replace function public.pm_sender_keys_for(p_thread uuid)
  returns table (sender_id text, generation int, epk text, wrapped_key text)
  language sql
  stable
  security definer
  set search_path = public
as $fn$
  select k.sender_id, k.generation, k.epk, k.wrapped_key
  from public.pm_sender_keys k
  where k.thread_id = p_thread
    and k.recipient_id = public.app_uid()
    and public.pm_is_member(p_thread)
  order by k.sender_id, k.generation;
$fn$;

-- ---------------------------------------------------------------------------
-- 6. Sending under a sender key
-- ---------------------------------------------------------------------------
-- The refusal below is the load-bearing line of this file. Without it a client
-- that forgot to rotate would keep sending under a key a removed member still
-- holds, and every single thing would look fine.
create or replace function public.pm_send_sk(
  p_thread     uuid,
  p_generation int,
  p_seq        int,
  p_iv         text,
  p_ciphertext text
) returns uuid
  language plpgsql
  security definer
  set search_path = public
as $fn$
declare
  v_uid text := public.app_uid();
  v_gen int;
  v_msg uuid;
begin
  if v_uid is null then raise exception 'Sign in first'; end if;
  if not exists (select 1 from public.pm_members where thread_id = p_thread and user_id = v_uid) then
    raise exception 'You are not in that conversation';
  end if;
  if coalesce(p_iv, '') = '' or coalesce(p_ciphertext, '') = '' then
    raise exception 'Nothing to send';
  end if;

  select key_generation into v_gen from public.pm_threads where id = p_thread;
  if p_generation < v_gen then
    raise exception 'The room has changed. Rotate your key to generation % before sending.', v_gen;
  end if;

  -- And you must actually have handed this generation out, or the message is
  -- unreadable to everyone including you.
  if not exists (
    select 1 from public.pm_sender_keys
    where thread_id = p_thread and sender_id = v_uid and generation = p_generation
  ) then
    raise exception 'Hand out your key for this generation before sending under it';
  end if;

  insert into public.pm_messages (thread_id, sender_id, alg, iv, ciphertext, generation, seq)
  values (p_thread, v_uid, 'SK-A256GCM', p_iv, p_ciphertext, p_generation, p_seq)
  returning id into v_msg;

  update public.pm_threads set last_at = now() where id = p_thread;
  return v_msg;
end $fn$;

-- ---------------------------------------------------------------------------
-- 7. Membership changes bump the generation
-- ---------------------------------------------------------------------------
-- Redefined here rather than edited in p_message_groups.sql so that file stays
-- readable as "what a room is" and this one owns "what rotation means". Both
-- are idempotent; whichever runs last wins, and they agree.
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

  -- Adding someone does not expose old messages (their wraps do not exist),
  -- but it DOES mean the current sender keys were handed out to a smaller
  -- room. Bumping keeps one invariant instead of two: the generation always
  -- matches the membership it was distributed to.
  if v_added > 0 then
    update public.pm_threads set key_generation = key_generation + 1 where id = p_thread;
  end if;

  return v_added;
end $fn$;

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

  -- THE important one. Removing someone who keeps a live sender key removes
  -- nothing at all.
  if v_gone > 0 then
    update public.pm_threads set key_generation = key_generation + 1 where id = p_thread;
    -- Their wraps are no use to anyone else and only clutter the table. This
    -- does NOT reach onto their device; what they already fetched is theirs.
    delete from public.pm_sender_keys where thread_id = p_thread and recipient_id = p_user;
  end if;
end $fn$;

create or replace function public.pm_group_leave(p_thread uuid)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $fn$
declare
  v_uid  text := public.app_uid();
  v_gone int;
begin
  if v_uid is null then raise exception 'Sign in first'; end if;
  with del as (
    delete from public.pm_members
    where thread_id = p_thread and user_id = v_uid
      and exists (select 1 from public.pm_threads t where t.id = p_thread and t.kind = 'group')
    returning 1
  )
  select count(*)::int into v_gone from del;

  if v_gone > 0 then
    update public.pm_threads set key_generation = key_generation + 1 where id = p_thread;
    delete from public.pm_sender_keys where thread_id = p_thread and recipient_id = v_uid;
  end if;
end $fn$;

-- ---------------------------------------------------------------------------
-- 8. Reading — messages now say which scheme sealed them
-- ---------------------------------------------------------------------------
-- Dropped first: adding columns to the returned row changes the signature, and
-- CREATE OR REPLACE cannot do that.
--
-- The join to pm_message_keys becomes a LEFT join, because a sender-key
-- message has no per-recipient wrap at all. An INNER join here would hide
-- every sender-key message from everyone — including its author.
drop function if exists public.pm_thread_messages(uuid, int);
create or replace function public.pm_thread_messages(
  p_thread uuid,
  p_limit  int default 100
) returns table (
  id          uuid,
  thread_id   uuid,
  sender_id   text,
  sender_name text,
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
  select
    msg.id, msg.thread_id, msg.sender_id,
    coalesce(k.display_name, ap.name),
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
    -- An ordinary message with no wrap for me is still not mine to see: that
    -- is what kept a late joiner out of a room's history, and it must keep
    -- doing so. A sender-key message carries no wrap by design, so it is
    -- judged by membership alone.
    and (msg.generation is not null or mk.wrapped_key is not null)
  order by msg.sent_at
  limit greatest(1, least(coalesce(p_limit, 100), 500));
$fn$;

-- ---------------------------------------------------------------------------
-- 9. The cap can move now
-- ---------------------------------------------------------------------------
-- 250 was set by the per-message cost: one ECDH per member, every message, on
-- the sender's phone. Under a sender key that cost is paid once per
-- generation, so the binding constraint is no longer the message — it is the
-- one-time distribution (about a second per thousand members on a laptop, and
-- a few on a phone) plus the plain fact that a thousand people in one chat is
-- a mailing list wearing a chat's clothes.
--
-- 1000 is therefore a product judgement, not a cryptographic one. Rooms above
-- pm_group_sk_threshold() use sender keys; below it they keep the simpler
-- per-message path, because fewer moving parts wins wherever cost does not.
create or replace function public.pm_group_max()
  returns int language sql immutable as $fn$ select 1000 $fn$;

create or replace function public.pm_group_sk_threshold()
  returns int language sql immutable as $fn$ select 25 $fn$;

-- ---------------------------------------------------------------------------
-- 10. Grants
-- ---------------------------------------------------------------------------
grant execute on function public.pm_group_sk_threshold()             to anon, authenticated;
grant execute on function public.pm_sender_key_put(uuid, int, jsonb) to anon, authenticated;
grant execute on function public.pm_sender_keys_for(uuid)            to anon, authenticated;
grant execute on function public.pm_send_sk(uuid, int, int, text, text) to anon, authenticated;
grant execute on function public.pm_thread_messages(uuid, int)       to anon, authenticated;

commit;

-- ============================================================================
-- The client flow for a large room:
--   1. read pm_threads.key_generation (comes back on the thread)
--   2. if you have not distributed that generation:
--        sk = PMCrypto.newSenderKey(generation)
--        wraps = PMCrypto.distributeSenderKey({...members...})
--        pm_sender_key_put(thread, generation, wraps)      -- once
--   3. every message: PMCrypto.sealWithSenderKey(...) -> pm_send_sk(...)
--   4. reading: pm_sender_keys_for(thread) once, then openWithSenderKey() per
--      message, falling back to open() for rows where generation is null.
-- ============================================================================
