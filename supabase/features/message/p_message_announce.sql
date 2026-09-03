-- ============================================================================
--  p_message_announce.sql — an announcement is one voice, and it can be closed.
-- ============================================================================
--  pm_broadcast() has always been admin-only to CREATE: it refuses anybody who
--  is not is_admin(), seals one body for the whole scope, and joins the admin
--  as 'owner' with every recipient as 'member'.
--
--  After that it stopped being an announcement. pm_send() and pm_send_sk() ask
--  one question, "are you in this conversation", and every recipient is. So
--  any one of the hundreds of people a national broadcast reached could write
--  back INTO it, and their reply went to all of them, under the announcement's
--  own title. That is not a reply to the sender, it is a second broadcast by
--  somebody with no right to make one, and there was nothing anywhere to stop
--  it or to say it had happened.
--
--  And it could never be cleaned up: pm_group_delete refuses anything that is
--  not kind = 'group' ('Only a room can be deleted'), so a broadcast thread was
--  permanent for everybody it reached, whatever it turned into.
--
--  THE RULE
--    announce        only the thread's owner, or a platform admin
--    delete          only the thread's owner, or a platform admin
--    everything else unchanged: recipients still READ it, still see it in
--                    their list, and can still leave it.
--
--  WHY OWNER *OR* ADMIN, RATHER THAN ADMIN ALONE
--  is_admin() is the platform's own staff check. The owner is whoever holds
--  role = 'owner' on the thread, which pm_broadcast sets to the admin who sent
--  it. Today those are the same person. Keying on the ROLE as well means an
--  announcement stays governable if the admin list ever changes underneath it,
--  which is the same reasoning p_message_delete.sql used for rooms: the
--  current owner, never created_by.
--
--  WHY A HELPER RATHER THAN THE CHECK INLINE TWICE
--  pm_send and pm_send_sk are two paths to the same act, and a rule written
--  twice is a rule that will be changed once. pm_can_announce() is the single
--  place, and it answers `true` for every non-broadcast thread so the direct
--  and room paths are untouched.
--
--  Depends on p_message.sql, p_message_groups.sql, p_message_delete.sql.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. May this person speak in this thread
-- ---------------------------------------------------------------------------
-- Not "is this a broadcast", because the answer for a direct thread and a room
-- has to be yes without the caller having to know that. STABLE so the planner
-- can call it once per statement.
create or replace function public.pm_can_announce(p_thread uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public
as $fn$
  select case
    when (select t.kind from public.pm_threads t where t.id = p_thread) is distinct from 'broadcast'
      then true
    when public.is_admin() then true
    else exists (
      select 1 from public.pm_members m
       where m.thread_id = p_thread
         and m.user_id = public.app_uid()
         and m.role = 'owner')
  end;
$fn$;

grant execute on function public.pm_can_announce(uuid) to anon, authenticated;

commit;

-- ---------------------------------------------------------------------------
-- 2. The two send paths refuse a broadcast from anybody but its owner
-- ---------------------------------------------------------------------------
-- Generated from the deployed definitions with one guard inserted after the
-- membership check. Same signature and same return type, so these are true
-- replacements: nothing is dropped and there is no window without them.

begin;

CREATE OR REPLACE FUNCTION public.pm_group_delete(p_thread uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid  text := public.app_uid();
  v_kind text;
begin
  if v_uid is null then
    raise exception 'Sign in first';
  end if;

  select t.kind into v_kind
    from public.pm_threads t where t.id = p_thread;

  -- Already gone. Same reasoning as deleting a message twice.
  if v_kind is null then
    return;
  end if;

  -- Direct threads are deliberately not deletable by one side. A conversation
  -- between two people is not one person's to erase from the other's phone,
  -- and "delete for me" already covers wanting it out of your own list.
  if v_kind not in ('group','broadcast') then
    raise exception 'Only a room or an announcement can be deleted here';
  end if;

  -- THE CURRENT OWNER, not created_by. pm_group_create makes the creator the
  -- owner, so for an untouched room these are the same person -- but they come
  -- apart the moment an owner leaves and section 5 hands the room to somebody
  -- else. Keying on created_by there would leave a room that its new owner can
  -- add to and remove from but nobody alive can close, which is the same dead
  -- end this file exists to remove. It is also the rule pm_group_add and
  -- pm_group_remove already use, so one role answers every question about a
  -- room rather than two rules that agree until they do not.
  if not (public.is_admin() or exists (
            select 1 from public.pm_members m
             where m.thread_id = p_thread
               and m.user_id = v_uid
               and m.role = 'owner')) then
    raise exception 'Only the owner can delete this';
  end if;

  delete from public.pm_threads where id = p_thread;
end $function$;
CREATE OR REPLACE FUNCTION public.pm_send(p_thread uuid, p_iv text, p_ciphertext text, p_keys jsonb, p_reply_to uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid text := public.app_uid();
  v_msg uuid;
  v_n   int;
begin
  if v_uid is null then raise exception 'Sign in first'; end if;
  if not exists (select 1 from public.pm_members where thread_id = p_thread and user_id = v_uid) then
    raise exception 'You are not in that conversation';
  end if;
  -- An announcement is one voice. Every recipient is a member, so the check
  -- above lets all of them write back INTO the broadcast, where their reply
  -- reaches everybody it reached. See p_message_announce.sql.
  if not public.pm_can_announce(p_thread) then
    raise exception 'Only the person who sent this announcement can add to it';
  end if;
  if coalesce(p_iv, '') = '' or coalesce(p_ciphertext, '') = '' then
    raise exception 'Nothing to send';
  end if;
  if length(p_ciphertext) > public.pm_max_ciphertext() then
    raise exception 'That message is too long to send';
  end if;
  if p_keys is null or jsonb_array_length(p_keys) = 0 then
    raise exception 'A message needs at least one wrapped key';
  end if;

  select count(*) into v_n from public.pm_messages
  where sender_id = v_uid and sent_at > now() - interval '1 minute';
  if v_n >= public.pm_max_msgs_per_min() then
    raise exception 'Too many messages in one minute. Wait a moment.';
  end if;

  insert into public.pm_messages (thread_id, sender_id, iv, ciphertext, reply_to)
  values (p_thread, v_uid, p_iv, p_ciphertext, public.pm_reply_target(p_thread, p_reply_to))
  returning id into v_msg;

  insert into public.pm_message_keys (message_id, user_id, epk, wrapped_key)
  select v_msg, k->>'user_id', k->>'epk', k->>'wrapped_key'
  from jsonb_array_elements(p_keys) k
  where exists (
    select 1 from public.pm_members m
    where m.thread_id = p_thread and m.user_id = k->>'user_id'
  )
  on conflict (message_id, user_id) do nothing;

  update public.pm_threads set last_at = now() where id = p_thread;
  return v_msg;
end $function$;
CREATE OR REPLACE FUNCTION public.pm_send_sk(p_thread uuid, p_generation integer, p_seq integer, p_iv text, p_ciphertext text, p_reply_to uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid text := public.app_uid();
  v_gen int;
  v_msg uuid;
  v_n   int;
begin
  if v_uid is null then raise exception 'Sign in first'; end if;
  if not exists (select 1 from public.pm_members where thread_id = p_thread and user_id = v_uid) then
    raise exception 'You are not in that conversation';
  end if;
  -- An announcement is one voice. Every recipient is a member, so the check
  -- above lets all of them write back INTO the broadcast, where their reply
  -- reaches everybody it reached. See p_message_announce.sql.
  if not public.pm_can_announce(p_thread) then
    raise exception 'Only the person who sent this announcement can add to it';
  end if;
  if coalesce(p_iv, '') = '' or coalesce(p_ciphertext, '') = '' then
    raise exception 'Nothing to send';
  end if;
  if length(p_ciphertext) > public.pm_max_ciphertext() then
    raise exception 'That message is too long to send';
  end if;

  select key_generation into v_gen from public.pm_threads where id = p_thread;
  if v_gen is null then raise exception 'No such conversation'; end if;
  if p_generation < v_gen then
    raise exception 'The room has changed. Rotate your key to generation % before sending.', v_gen;
  end if;
  if p_generation > v_gen then
    raise exception 'The room has not reached generation % — rotate your key to generation %',
      p_generation, v_gen;
  end if;

  if not exists (
    select 1 from public.pm_sender_keys
    where thread_id = p_thread and sender_id = v_uid and generation = p_generation
  ) then
    raise exception 'Hand out your key for this generation before sending under it';
  end if;

  select count(*) into v_n from public.pm_messages
  where sender_id = v_uid and sent_at > now() - interval '1 minute';
  if v_n >= public.pm_max_msgs_per_min() then
    raise exception 'Too many messages in one minute. Wait a moment.';
  end if;

  insert into public.pm_messages (thread_id, sender_id, alg, iv, ciphertext, generation, seq, reply_to)
  values (p_thread, v_uid, 'SK-A256GCM', p_iv, p_ciphertext, p_generation, p_seq,
          public.pm_reply_target(p_thread, p_reply_to))
  returning id into v_msg;

  update public.pm_threads set last_at = now() where id = p_thread;
  return v_msg;
end $function$;
commit;
