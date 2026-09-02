-- ============================================================================
--  p_message_purge.sql — taking a whole conversation out of the list.
-- ============================================================================
--  p_message_delete.sql gave one message an undo and gave a room a way to be
--  closed. Both of those live INSIDE a thread: you have to open the room and
--  find the roster sheet to close it, and there was nothing at all for the
--  other half of a busy inbox.
--
--  Two rows nobody could ever get rid of:
--
--    1. A guest enquiry. Anyone can open P-Message without an account, type a
--       name and write to an agent. An agent who lists three houses collects
--       these the way a phone collects missed calls, and every one of them is
--       permanent: pm_group_delete refuses anything that is not a room, and a
--       direct thread has no owner to close it.
--    2. A guest who has since GONE. pm_guest_forget deletes the guest's key
--       and every membership, which is right, but it leaves the thread itself
--       standing in the agent's list with nobody on the other side: a row
--       called "Someone" holding ciphertext no living key can open, which
--       cannot be answered, cannot be reported and could not be removed.
--
--  WHAT THIS ADDS
--    pm_direct_delete(thread)   deletes a one to one conversation, with the
--                               rules below.
--    pm_inbox()                 gains my_role, so the list knows who owns a
--                               room without asking a second question per row.
--
--  WHO MAY DELETE A DIRECT THREAD, AND WHY IT IS NOT SIMPLY "EITHER SIDE"
--  p_message_delete.sql refused to let one person delete a direct thread, and
--  that refusal was right for the case it was written about: two accounts in a
--  conversation, where one of them erasing it takes the other person's half
--  with it. Nothing here changes that.
--
--  A guest is a different thing, and the difference is not politeness, it is
--  what the identity IS. A guest session is a browser tab. It cannot be signed
--  into again, it holds its only private key in that tab's storage, and it is
--  fenced out of everything the catalogue offers precisely because nobody
--  vouched for it. So:
--
--    the other side is a guest  -> the account may delete the conversation.
--    the other side has left    -> anyone still in it may delete it. There is
--                                  no second half left to protect.
--    two accounts               -> refused, exactly as before.
--    an admin                   -> may delete either, which is the same reach
--                                  pm_message_delete and pm_group_delete give.
--
--  A GUEST MAY NOT CALL THIS. Deleting from the guest's side would erase the
--  agent's copy of a conversation the agent may need, on the say-so of a tab.
--  A guest who wants out has pm_guest_forget (p_message_guest_end.sql), which
--  removes THEM and leaves what was said unless they ask for it to go.
--
--  WHY THIS ONE REALLY DELETES, WHILE A MESSAGE ONLY TOMBSTONES
--  A tombstone exists so a conversation still reads correctly with a hole in
--  it. Delete the whole thread and there is no conversation left to read: no
--  replies pointing into it, no sender-key sequence to keep numbered, nobody
--  to be honest to. Everything hanging off pm_threads is ON DELETE CASCADE
--  (pm_members, pm_messages and pm_message_keys through them, pm_sender_keys),
--  and pm_invites is ON DELETE SET NULL, so one delete is the whole operation.
--
--  Idempotent. Safe to re-run, and safe to CALL twice: the second call finds
--  no thread and reports that nothing was deleted rather than raising.
--
--  Depends on p_message.sql, p_message_guests.sql, p_message_groups.sql.
--  Run it AFTER p_message_guests.sql: it redefines pm_inbox, so re-running the
--  guests file would revert the my_role column.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Delete a one to one conversation
-- ---------------------------------------------------------------------------
-- Returns what happened rather than void, because the screen has two different
-- sentences to say: one for a conversation that was deleted here and now, and
-- one for a row that was already gone on another device. jsonb rather than a
-- composite type to match pm_guest_forget, which reports the same shape of
-- news for the same reason.
create or replace function public.pm_direct_delete(p_thread uuid)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $fn$
declare
  v_uid   text := public.app_uid();
  v_kind  text;
  v_other text;
  v_guest boolean;
  v_msgs  int := 0;
begin
  if v_uid is null then
    raise exception 'Sign in first';
  end if;

  select t.kind into v_kind from public.pm_threads t where t.id = p_thread;

  -- Already gone. Same reasoning as deleting a message twice: somebody tapping
  -- through a slow connection meant it once.
  if v_kind is null then
    return jsonb_build_object('deleted', false, 'messages', 0);
  end if;

  -- A room has its own door (pm_group_delete), which asks a different question
  -- of a different person. Sending a room through here would let a member
  -- delete a room they do not own.
  if v_kind <> 'direct' then
    raise exception 'Only a one to one conversation can be deleted here';
  end if;

  if not public.pm_is_member(p_thread) and not public.is_admin() then
    raise exception 'You are not in that conversation';
  end if;

  -- The guest fence, and the reason for it is in the header: a tab cannot
  -- decide that an agent no longer has a record of what was said to them.
  if public.app_is_guest() then
    raise exception 'Ending your guest session is how you leave. It does not delete what the other person keeps';
  end if;

  select m.user_id into v_other
    from public.pm_members m
   where m.thread_id = p_thread and m.user_id <> v_uid
   limit 1;

  select coalesce(k.is_guest, false) into v_guest
    from public.pm_keys k where k.user_id = v_other;

  -- Two accounts. Unchanged from p_message_delete.sql, and the message says
  -- which half of the rule stopped it rather than a flat refusal.
  if v_other is not null and not coalesce(v_guest, false) and not public.is_admin() then
    raise exception 'This conversation is also theirs, so it cannot be deleted from one side';
  end if;

  -- Counted before the delete, for the sentence afterwards. It is the number
  -- of rows on the SERVER, which is the only number this function can honestly
  -- report: what either phone already downloaded is not ours to count.
  select count(*)::int into v_msgs
    from public.pm_messages where thread_id = p_thread;

  delete from public.pm_threads where id = p_thread;

  return jsonb_build_object(
    'deleted',  true,
    'messages', v_msgs,
    'guest',    coalesce(v_guest, false),
    'orphan',   v_other is null);
end $fn$;

-- ---------------------------------------------------------------------------
-- 2. The inbox says what you are in a thread
-- ---------------------------------------------------------------------------
-- One column, my_role, and it is there to stop the list offering a door the
-- database will shut. Closing a room is the owner's, so the list has to know
-- who owns each room BEFORE it draws the menu -- and the alternative was a
-- roster query per room, on a screen whose whole design note says a thread
-- list that fires one request per line is how a list gets slow.
--
-- Redefined here rather than edited in p_message_guests.sql, following the
-- layering p_message_delete.sql uses on p_message_replies.sql: each file adds
-- what it needs and the last one to run wins.
drop function if exists public.pm_inbox();
create or replace function public.pm_inbox()
  returns table (
    thread_id    uuid,
    kind         text,
    title        text,
    region       text,
    other_id     text,
    other_name   text,
    other_region text,
    other_area   text,
    other_guest  boolean,
    my_role      text,
    last_at      timestamptz,
    unread       int
  )
  language sql
  stable
  security definer
  set search_path = public
as $$
  with me as (select public.app_uid() as uid),
  mine as (
    select m.thread_id, m.last_read_at, m.role
    from public.pm_members m, me
    where m.user_id = me.uid
  )
  select
    t.id, t.kind, t.title, t.region,
    o.user_id, coalesce(k.display_name, ap.name), coalesce(k.region, ap.region),
    ap.area_of_operations,
    coalesce(k.is_guest, false),
    mine.role,
    t.last_at,
    (select count(*)::int from public.pm_messages msg
      where msg.thread_id = t.id
        and msg.sender_id <> (select uid from me)
        and (mine.last_read_at is null or msg.sent_at > mine.last_read_at))
  from mine
  join public.pm_threads t on t.id = mine.thread_id
  left join lateral (
    select m2.user_id from public.pm_members m2
    where m2.thread_id = t.id and m2.user_id <> (select uid from me) and t.kind = 'direct'
    limit 1
  ) o on true
  left join public.pm_keys k on k.user_id = o.user_id
  left join public.agent_profiles ap on ap.user_id = o.user_id
  order by t.last_at desc;
$$;

-- ---------------------------------------------------------------------------
-- 3. Grants
-- ---------------------------------------------------------------------------
grant execute on function public.pm_direct_delete(uuid) to anon, authenticated;
grant execute on function public.pm_inbox()             to anon, authenticated;

commit;
