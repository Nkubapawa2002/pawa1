-- ============================================================================
--  p_message_delete.sql — taking something back.
-- ============================================================================
--  Three things could not be undone in P-Message, and all three are ordinary
--  things people do in every chat app they have ever used:
--
--    1. Unsend a message. "Delete" existed and meant "hide it on this phone".
--       That is an honest feature and it stays, but it is not what the word
--       means to anyone who taps it, and the gap between the two is where a
--       wrong number, a wrong price and a wrong address live forever.
--    2. Close a room you opened. pm_group_create had no opposite. An admin who
--       opened "Mwanza trucks" by mistake could remove every member one at a
--       time and still leave the room sitting in nobody's inbox.
--    3. Leave a room you own. pm_group_leave deleted your membership whoever
--       you were, so an owner leaving left a room with no owner: nobody could
--       add anyone, nobody could remove anyone, and nobody could delete it.
--
--  WHAT "DELETE FOR EVERYONE" ACTUALLY DOES, AND WHAT IT CANNOT DO
--  It blanks the ciphertext and drops every wrapped key for the message. After
--  it runs there is nothing on the server to decrypt and no key to decrypt it
--  with, for anybody, including us. That is a real deletion and not a flag the
--  UI agrees to respect.
--
--  It does NOT reach a phone that already downloaded and opened the message.
--  Nothing can. A copy that was read, screenshotted or backed up is theirs,
--  and the UI must say so in those words rather than implying a recall.
--
--  WHY A TOMBSTONE INSTEAD OF DELETING THE ROW
--  The row stays, with deleted_at set and no content. Three reasons, in order
--  of how much they would have hurt:
--
--    • replies. reply_to points at a message id. p_message_replies.sql chose
--      ON DELETE SET NULL precisely so a vanishing parent could not take the
--      answers with it, and a tombstone is better still: the answer keeps its
--      question, and the question says plainly that it was withdrawn.
--    • sender keys. A room above the threshold seals by generation and seq,
--      not by per-member wraps. Removing the row would leave a hole in a
--      numbered sequence, which is indistinguishable from a message a client
--      failed to fetch, which is the one thing the seq column exists to tell
--      apart.
--    • honesty. A message that silently ceases to have existed rewrites a
--      conversation. "This was deleted" is a fact about what happened and the
--      other person is entitled to it.
--
--  WHO MAY DELETE WHAT
--    a message  its sender, or an admin.
--    a room     the person who opened it, or an admin.
--    a place    anybody, for themselves, which is what leaving is.
--
--  An admin can delete a message they cannot read. That is deliberate and it
--  is the only power over content this schema grants them: removing something
--  reported as abuse should not require being able to open it, and being able
--  to open it is exactly what this whole feature refuses.
--
--  Idempotent. Safe to re-run. Depends on p_message.sql, p_message_groups.sql,
--  p_message_replies.sql, p_message_sender_keys.sql.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. The tombstone columns
-- ---------------------------------------------------------------------------
alter table public.pm_messages add column if not exists deleted_at timestamptz;
alter table public.pm_messages add column if not exists deleted_by text;

-- Deleted messages are read on every thread open, and a thread is always read
-- newest first. Partial, because the overwhelming majority of rows are not
-- deleted and there is no reason to carry them in this index.
create index if not exists pm_messages_deleted_idx
  on public.pm_messages (thread_id, sent_at desc)
  where deleted_at is not null;

-- ---------------------------------------------------------------------------
-- 2. Unsend
-- ---------------------------------------------------------------------------
-- Returns the deletion time so the caller can draw the tombstone without a
-- second round trip, and so a second call on an already-deleted message is a
-- no-op that reports the FIRST deletion rather than an error. A person tapping
-- delete twice on a slow connection meant it once.
create or replace function public.pm_message_delete(p_message uuid)
  returns timestamptz
  language plpgsql
  security definer
  set search_path = public
as $fn$
declare
  v_uid     text := public.app_uid();
  v_sender  text;
  v_thread  uuid;
  v_deleted timestamptz;
begin
  if v_uid is null then
    raise exception 'Sign in first';
  end if;

  select m.sender_id, m.thread_id, m.deleted_at
    into v_sender, v_thread, v_deleted
    from public.pm_messages m
   where m.id = p_message;

  if v_thread is null then
    raise exception 'That message is not there any more';
  end if;

  -- Already done. Not an error: see the note above the function.
  if v_deleted is not null then
    return v_deleted;
  end if;

  -- Membership is checked as well as authorship. Without it, someone who had
  -- been removed from a room could still reach back into it and delete what
  -- they said there, which is a write to a thread they can no longer read.
  if not public.pm_is_member(v_thread) and not public.is_admin() then
    raise exception 'You are not in that conversation';
  end if;

  if v_sender is distinct from v_uid and not public.is_admin() then
    raise exception 'You can only delete your own messages';
  end if;

  -- The content goes first and the bookkeeping second, in one statement, so
  -- there is no instant where the row is marked deleted but still readable.
  update public.pm_messages
     set deleted_at = now(),
         deleted_by = v_uid,
         ciphertext = '',
         iv         = ''
   where id = p_message
  returning deleted_at into v_deleted;

  -- With every wrap gone there is no key to open it with, for anyone. In a
  -- sender-key room there were never per-member wraps, and the blank
  -- ciphertext above is what does the work there.
  delete from public.pm_message_keys where message_id = p_message;

  return v_deleted;
end $fn$;

-- ---------------------------------------------------------------------------
-- 3. Reading a thread that contains tombstones
-- ---------------------------------------------------------------------------
-- pm_thread_messages is redefined here rather than edited in
-- p_message_replies.sql, following the same layering p_message_jobs.sql uses
-- on p_message_groups.sql: each file adds what it needs and the last one to
-- run wins. Re-running the replies file after this one would revert it, so
-- the order in ops/ matters and this file is listed after it.
--
-- TWO CHANGES, and the second is the one that is easy to miss:
--   • deleted_at joins the row, so the client can draw a tombstone instead of
--     a failed decryption.
--   • the "do I have a way to read this" filter has to let tombstones THROUGH.
--     It reads `generation is not null or wrapped_key is not null`, and a
--     deleted message has neither: its wrap is gone. Without the third arm
--     below, deleting a message in a direct thread would make it disappear
--     completely, which is precisely the rewriting-history behaviour section 1
--     of this file exists to avoid.
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
    sent_at      timestamptz,
    deleted_at   timestamptz
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
      msg.generation, msg.seq, msg.reply_to, msg.sent_at, msg.deleted_at
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
      and (msg.generation is not null
           or mk.wrapped_key is not null
           or msg.deleted_at is not null)
    order by msg.sent_at desc
    limit greatest(1, least(coalesce(p_limit, 100), 500))
  )
  select * from page order by sent_at;
$fn$;

-- ---------------------------------------------------------------------------
-- 4. Closing a room
-- ---------------------------------------------------------------------------
-- Everything hanging off the thread is already ON DELETE CASCADE: pm_members,
-- pm_messages (and pm_message_keys through them) and pm_sender_keys. pm_invites
-- is ON DELETE SET NULL, so an invite link to a deleted room survives as a dead
-- token rather than vanishing, and pm_invite_accept refuses it. One delete is
-- therefore the whole operation and there is no order to get wrong.
create or replace function public.pm_group_delete(p_thread uuid)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $fn$
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
  if v_kind <> 'group' then
    raise exception 'Only a room can be deleted';
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
    raise exception 'Only the owner of this room can delete it';
  end if;

  delete from public.pm_threads where id = p_thread;
end $fn$;

-- ---------------------------------------------------------------------------
-- 5. Leaving a room, including as its owner
-- ---------------------------------------------------------------------------
-- The old version was three lines and deleted your membership whoever you
-- were. Two states it could leave behind, both of them dead ends:
--
--   the last member leaves  -> a room with no members, invisible to everyone,
--                              holding ciphertext nobody can ever read again.
--   the OWNER leaves        -> a room nobody can add to, remove from, or
--                              delete, because every one of those checks asks
--                              for a role no row now carries.
--
-- So leaving now finishes the job. The return value says which of the three
-- things happened, because the screen has to say something different in each
-- case and guessing from the inbox afterwards is how they get confused.
drop function if exists public.pm_group_leave(uuid);

create or replace function public.pm_group_leave(p_thread uuid)
  returns text
  language plpgsql
  security definer
  set search_path = public
as $fn$
declare
  v_uid  text := public.app_uid();
  v_role text;
  v_left int;
  v_next text;
begin
  if v_uid is null then
    raise exception 'Sign in first';
  end if;

  if not exists (select 1 from public.pm_threads t
                  where t.id = p_thread and t.kind = 'group') then
    raise exception 'Only a room can be left';
  end if;

  select m.role into v_role from public.pm_members m
   where m.thread_id = p_thread and m.user_id = v_uid;

  -- Not in it. Nothing to do, and nothing to apologise for.
  if v_role is null then
    return 'not_member';
  end if;

  delete from public.pm_members
   where thread_id = p_thread and user_id = v_uid;

  select count(*) into v_left from public.pm_members where thread_id = p_thread;

  -- Nobody left. The room is ciphertext no living key can open, so it goes
  -- rather than sitting in the table forever.
  if v_left = 0 then
    delete from public.pm_threads where id = p_thread;
    return 'deleted';
  end if;

  -- The owner walked out of a room that still has people in it. The longest
  -- standing member takes it over: it is the least arbitrary rule available
  -- without asking, and asking is not possible at the moment somebody leaves.
  if v_role = 'owner' then
    select m.user_id into v_next
      from public.pm_members m
     where m.thread_id = p_thread
     order by m.joined_at asc, m.user_id asc
     limit 1;

    update public.pm_members
       set role = 'owner'
     where thread_id = p_thread and user_id = v_next;

    return 'handed_over';
  end if;

  return 'left';
end $fn$;

-- ---------------------------------------------------------------------------
-- 6. Grants
-- ---------------------------------------------------------------------------
grant execute on function public.pm_message_delete(uuid)     to anon, authenticated;
grant execute on function public.pm_thread_messages(uuid, int) to anon, authenticated;
grant execute on function public.pm_group_delete(uuid)       to anon, authenticated;
grant execute on function public.pm_group_leave(uuid)        to anon, authenticated;

commit;
