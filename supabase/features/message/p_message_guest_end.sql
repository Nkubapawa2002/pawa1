-- ============================================================================
--  p_message_guest_end.sql — ending a guest session actually ends it.
-- ============================================================================
--  A guest is a real Supabase session with no account behind it. Signing out
--  of one was a purely LOCAL act: js/pages/profile.js forgot the private key
--  and the pinned-key book, then called signOut. Everything the guest had put
--  on the server stayed exactly where it was.
--
--  So after "End this guest session" the guest was still:
--
--    a row in pm_keys, carrying a published public key, which is what makes
--    somebody reachable. Anyone holding the thread could seal a new message to
--    an identity that no longer has, and can never again have, the private key
--    to open it. Those messages are unreadable the moment they are written.
--
--    a member of every conversation they had joined, sitting in the roster of
--    each one as a name that will never answer.
--
--  Neither is recoverable by the guest, because an anonymous session cannot be
--  signed into again: the id is gone with the browser. Leaving the rows behind
--  is not "keeping their account", it is litter that other people can still
--  write to.
--
--  WHAT THIS DELETES, AND WHAT IT DELIBERATELY DOES NOT
--  It deletes the guest's key and their membership of every thread. That is
--  what "removed" means: unreachable, and gone from every roster.
--
--  It does NOT delete what they SENT, unless they ask. Those messages are also
--  the other person's half of a conversation, and quietly erasing them would
--  rewrite somebody else's history because a stranger closed a browser tab.
--  p_wipe_messages is the opt-in, and when it is set the messages are
--  tombstoned by exactly the same rule as pm_message_delete: blank ciphertext,
--  every wrap dropped, the row left behind saying it was deleted.
--
--  ONLY A GUEST, AND ONLY THEMSELVES. app_is_guest() gates the whole function,
--  so an account calling it is refused rather than quietly wiped: for an
--  account, signing out is supposed to destroy nothing, and this is the one
--  place where confusing the two would be unrecoverable.
--
--  A guest is never in a group room. Every membership insert in
--  p_message_groups.sql joins pm_keys with `not coalesce(is_guest,false)`, so
--  there is no ownership to hand over here and no room that can be orphaned by
--  a guest leaving. Direct threads have no owner.
--
--  Idempotent. Safe to re-run, and safe to CALL twice: the second call finds
--  nothing and reports zeros.
--
--  Depends on p_message.sql, p_message_guests.sql, p_message_delete.sql.
-- ============================================================================

begin;

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
begin
  if v_uid is null then
    raise exception 'There is no session to end';
  end if;

  -- The fence. An account reaching this by accident would lose its key row and
  -- every conversation, and unlike a guest it has somewhere to come back to.
  if not public.app_is_guest() then
    raise exception 'Only a guest session can be ended this way';
  end if;

  -- Optional, and off by default. Same tombstone as pm_message_delete: the row
  -- survives so the other person's conversation still makes sense, and there
  -- is nothing left on the server to decrypt.
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

  -- Leave every conversation. Direct threads only, per the header.
  with departed as (
    delete from public.pm_members
     where user_id = v_uid
    returning thread_id
  )
  select count(*) into v_threads from departed;

  -- And stop being reachable. Without the key row nobody can seal anything to
  -- this identity, and it disappears from every directory and roster that is
  -- built by joining pm_keys.
  delete from public.pm_keys where user_id = v_uid;

  return jsonb_build_object('threads', v_threads, 'messages', v_msgs);
end $fn$;

grant execute on function public.pm_guest_forget(boolean) to anon, authenticated;

commit;
