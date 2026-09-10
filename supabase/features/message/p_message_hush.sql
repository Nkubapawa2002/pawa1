-- ============================================================================
--  p_message_hush.sql — a block reaches the conversation you already have.
-- ============================================================================
--  p_message_audience.sql stopped a blocked person opening a NEW conversation,
--  adding you to a room, and putting you in an announcement. It left the one
--  case that matters most untouched: the conversation the two of you already
--  have.
--
--  That gap is not an edge. Everybody an advertiser can reach is by definition
--  somebody they have already written to, so the thread already exists, and
--  pm_start_direct's idempotent lookup hands it straight back. A block that
--  stops everything except the channel the person is actually using is a
--  safety control that does almost nothing, which is worse than none, because
--  people act on the promise.
--
--  WHERE THE GUARD GOES
--  pm_send and pm_send_sk already call ONE function to ask "may this person
--  write here", and it is pm_can_announce(). That function's answer is right
--  about announcements and silent about blocks. So:
--
--    pm_can_speak(thread) = pm_can_announce(thread)
--                           AND not blocked, in a DIRECT thread
--
--  and the two send paths call pm_can_speak instead. pm_can_announce keeps its
--  narrower, honest meaning and its own tests; nothing that calls it changes.
--
--  WHY ONLY A DIRECT THREAD. A room and an announcement hold many people. If
--  one member blocking another silenced the sender for everybody, a single
--  person could switch off a room they merely dislike. Leaving a shared room
--  is the act that exists for that, and this file does not invent a second.
--
--  THE ERROR NAMES NO DIRECTION. "You cannot send messages in this
--  conversation" is what both sides would see if the roles were reversed, so
--  it does not tell the blocked person who pressed it or when. The screen
--  greys the composer through setComposerBlocked() rather than letting somebody
--  type a paragraph into a box that will refuse it.
--
--  The two functions below are the DEPLOYED definitions with exactly one line
--  changed in each. Same signature, same return type, so these are true
--  replacements and there is no window without them. Same method
--  p_message_announce.sql used when it inserted that guard in the first place.
--
--  Idempotent. Safe to re-run. Depends on p_message_announce.sql and
--  p_message_audience.sql.
--
--    usage:  node scripts/db/apply_sql.mjs supabase/features/message/p_message_hush.sql
-- ============================================================================

begin;

do $$
begin
  if to_regprocedure('public.pm_blocked_between(text,text)') is null then
    raise exception 'Apply supabase/features/message/p_message_audience.sql first';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. May this person write here at all
-- ---------------------------------------------------------------------------
create or replace function public.pm_can_speak(p_thread uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public
as $fn$
  select public.pm_can_announce(p_thread)
     and not exists (
       select 1
         from public.pm_threads t
         join public.pm_members other
           on other.thread_id = t.id and other.user_id <> public.app_uid()
        where t.id = p_thread
          and t.kind = 'direct'
          and public.pm_blocked_between(public.app_uid(), other.user_id)
     );
$fn$;

grant execute on function public.pm_can_speak(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. The two send paths ask the wider question
-- ---------------------------------------------------------------------------
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
  -- An announcement is one voice, and a blocked person is no voice at all.
  -- Both are the same question -- may this person write here -- so both are
  -- asked once, by pm_can_speak(). See p_message_hush.sql.
  if not public.pm_can_speak(p_thread) then
    if public.pm_can_announce(p_thread) then
      raise exception 'You cannot send messages in this conversation.';
    end if;
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
  -- The same one question, asked the same way. A room is never silenced by a
  -- block: pm_can_speak only looks at direct threads, because one member
  -- blocking another must not switch off a room for everybody in it.
  if not public.pm_can_speak(p_thread) then
    if public.pm_can_announce(p_thread) then
      raise exception 'You cannot send messages in this conversation.';
    end if;
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
