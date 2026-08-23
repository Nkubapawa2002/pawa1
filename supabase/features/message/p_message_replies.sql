-- ============================================================================
--  p_message_replies.sql — answering ONE message, in a room where forty
--  people are talking.
-- ============================================================================
--  A direct thread does not need this. A room does, and rooms are the whole
--  point of the group feature: with thirty agents in a Mwanza trucks room,
--  "yes, 300,000" is an answer to a question that scrolled past nine messages
--  ago and it is unreadable without the thing it answers. Every group chat
--  people already use solves this the same way, so the absence reads as the
--  feature being unfinished rather than as a decision.
--
--  WHAT IS STORED, AND WHAT IS NOT
--  One column: reply_to, the id of another message in the SAME thread. That
--  is all. The quoted text is NOT copied into the reply, and this is the
--  whole design:
--
--    • the quote is drawn from the copy the reading device already decrypted,
--      so it costs no second ciphertext and can never disagree with the
--      original;
--    • a quote stored alongside the reply would be a second, independent
--      encryption of the same words — twice the surface, and a place where a
--      client could put text the original never contained;
--    • someone who cannot open the quoted message (they joined the room
--      after it was sent, or it is outside the page they loaded) sees a
--      neutral "an earlier message" and NOT a fabricated preview. A reply to
--      something you are not entitled to read must not leak it, and the only
--      way to be sure of that is to never have it to leak.
--
--  reply_to is METADATA. Anyone with database access can see that message B
--  answers message A, exactly as they can already see who wrote to whom and
--  when. docs/P_MESSAGE.md has always said metadata is in the clear; this is
--  one more fact in that set, and it is listed there.
--
--  ON DELETE SET NULL rather than CASCADE: a reply is a message in its own
--  right and losing its parent must not delete it. Nothing deletes messages
--  today except a thread going away, which cascades anyway — the clause is
--  there so that when something does, it cannot take the answers with it.
--
--  BOTH SEND PATHS
--  pm_send and pm_send_sk. A room above the sender-key threshold is exactly
--  the room where replies matter most, so wiring only the small-room path
--  would have shipped the feature to the conversations that need it least.
--
--  Signatures change (a defaulted fifth/sixth argument), so both functions are
--  dropped and recreated. PostgREST calls them by NAMED arguments, so callers
--  that never pass p_reply_to keep working untouched.
--
--  Idempotent. Safe to re-run. Depends on p_message.sql, _sender_keys,
--  _security.
--
--    usage:  node scripts/db/apply_sql.mjs supabase/features/message/p_message_replies.sql
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. The column
-- ---------------------------------------------------------------------------
alter table public.pm_messages
  add column if not exists reply_to uuid references public.pm_messages(id) on delete set null;

-- Drawing a thread means resolving every reply_to in the page. Without this
-- that is a sequential scan per message.
create index if not exists pm_messages_reply_idx on public.pm_messages (reply_to)
  where reply_to is not null;

comment on column public.pm_messages.reply_to is
  'The message this one answers, same thread only. Metadata, not encrypted. The quoted TEXT is never stored — see p_message_replies.sql.';

-- ---------------------------------------------------------------------------
-- 2. One place that decides whether a reply target is allowed
-- ---------------------------------------------------------------------------
-- Two send paths would otherwise each carry their own copy of the rule, and
-- the copy that drifts is the one nobody is looking at. Null in, null out:
-- "this is not a reply" is the ordinary case, not an error.
--
-- The rule is only that the target is a message in the same thread. It is
-- deliberately NOT "a message you can read": in a room you may reply to
-- something sent before you joined, which you cannot decrypt, and the client
-- shows that as an unnamed earlier message. Forbidding it would be enforcing
-- a rule the sender cannot see the reason for.
create or replace function public.pm_reply_target(p_thread uuid, p_reply_to uuid)
  returns uuid
  language plpgsql
  stable
  security definer
  set search_path = public
as $$
begin
  if p_reply_to is null then return null; end if;
  if not exists (
    select 1 from public.pm_messages
    where id = p_reply_to and thread_id = p_thread
  ) then
    raise exception 'You can only reply to a message in this conversation';
  end if;
  return p_reply_to;
end $$;

-- ---------------------------------------------------------------------------
-- 3. pm_send
-- ---------------------------------------------------------------------------
drop function if exists public.pm_send(uuid, text, text, jsonb);

create or replace function public.pm_send(
  p_thread     uuid,
  p_iv         text,
  p_ciphertext text,
  p_keys       jsonb,
  p_reply_to   uuid default null
) returns uuid
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_uid text := public.app_uid();
  v_msg uuid;
  v_n   int;
begin
  if v_uid is null then raise exception 'Sign in first'; end if;
  if not exists (select 1 from public.pm_members where thread_id = p_thread and user_id = v_uid) then
    raise exception 'You are not in that conversation';
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
end $$;

grant execute on function public.pm_send(uuid, text, text, jsonb, uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. pm_send_sk
-- ---------------------------------------------------------------------------
drop function if exists public.pm_send_sk(uuid, int, int, text, text);

create or replace function public.pm_send_sk(
  p_thread     uuid,
  p_generation int,
  p_seq        int,
  p_iv         text,
  p_ciphertext text,
  p_reply_to   uuid default null
) returns uuid
  language plpgsql
  security definer
  set search_path = public
as $$
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
end $$;

grant execute on function public.pm_send_sk(uuid, int, int, text, text, uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. The thread carries it back
-- ---------------------------------------------------------------------------
-- Only the id. The client pairs it with the copy it already decrypted; see
-- the header for why no preview is sent from here.
drop function if exists public.pm_thread_messages(uuid, int);

create or replace function public.pm_thread_messages(p_thread uuid, p_limit int default 100)
  returns table (
    id           uuid,
    thread_id    uuid,
    sender_id    text,
    sender_name  text,
    sender_guest boolean,
    alg          text,
    iv           text,
    ciphertext   text,
    epk          text,
    wrapped_key  text,
    generation   int,
    seq          int,
    reply_to     uuid,
    sent_at      timestamptz
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
      coalesce(k.is_guest, false)       as sender_guest,
      msg.alg, msg.iv, msg.ciphertext, mk.epk, mk.wrapped_key,
      msg.generation, msg.seq, msg.reply_to, msg.sent_at
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
      and (msg.generation is not null or mk.wrapped_key is not null)
    order by msg.sent_at desc
    limit greatest(1, least(coalesce(p_limit, 100), 500))
  )
  select * from page order by sent_at;
$fn$;

grant execute on function public.pm_thread_messages(uuid, int) to anon, authenticated;

commit;
